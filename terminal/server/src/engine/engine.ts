import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Db } from '../store/db.js';
import type {
  AmountSpec,
  Hook,
  ManagedPosition,
  MarketType,
  PendingIntent,
  PositionDir,
  Signal,
  SignalLogEntry,
} from '../store/types.js';
import type { ExchangeAdapter, ExchangePosition, FillEvent, SymbolInfo } from '../exchange/types.js';
import { computeBaseQty, type AmountCtx } from './amount.js';
import { decide, relevantSide } from './decide.js';
import { planGrid, planTpOrders, slPrice as computeSlPrice, updateTrailing } from './modules.js';
import { quantizeOrder, quantizePrice, quantizeQty } from './quantizer.js';
import { effectiveHook, parseSignal, SignalError, signalTpOrders } from './signal.js';
import { defaultGridConfig, defaultSlModule, defaultSlxModule, defaultTpModule } from './defaults.js';

export type AdapterFactory = (accountId: string, market: MarketType) => Promise<ExchangeAdapter>;

/** Pending intents older than this with no matching position are dropped. */
const INTENT_TTL_MS = 3 * 24 * 60 * 60_000;

/**
 * A managed position younger than this is never pruned as "closed on the
 * exchange", even if a positions snapshot doesn't list it yet — guards against
 * a snapshot that predates a just-opened position.
 */
const PRUNE_GRACE_MS = 15_000;

export interface ManualOrderInput {
  accountId: string;
  market: MarketType;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop_market';
  /** Explicit base quantity. Ignored when `amount` is given. */
  qty?: number;
  /** Size by a Finandy amount mode (e.g. % of portfolio); overrides qty. */
  amount?: AmountSpec;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  leverage?: number;
  marginMode?: 'cross' | 'isolated';
  /** Spread qty over a grid of limit orders instead of one order. */
  grid?: import('../store/types.js').GridConfig;
  tp?: ManagedPosition['config']['tp'];
  sl?: ManagedPosition['config']['sl'];
  slx?: ManagedPosition['config']['slx'];
}

/**
 * The trading engine: executes webhook signals and manual orders through an
 * exchange adapter and manages position lifecycles (TP grid, SL, trailing,
 * breakeven, reversal) the way Finandy's terminal does.
 */
export class TradingEngine extends EventEmitter {
  private adapters = new Map<string, ExchangeAdapter>();
  private intents = new Map<string, PendingIntent>();
  private trailingBusy = new Set<string>();
  private fillQueues = new Map<string, Promise<void>>();
  private priceListeners: ((symbol: string, price: number) => void)[] = [];
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly db: Db,
    private readonly adapterFactory: AdapterFactory,
  ) {
    super();
    // Restore intents whose fill may not have arrived before the last shutdown.
    for (const [key, intent] of Object.entries(this.db.pendingIntents)) {
      this.intents.set(key, intent);
    }
  }

  /** Persist an intent so a missed fill or restart doesn't lose its TP/SL. */
  private setIntent(key: string, intent: PendingIntent): void {
    this.intents.set(key, intent);
    this.db.pendingIntents[key] = intent;
    this.db.save();
  }

  /** Persist a mutation to an already-stored intent (e.g. new order ids). */
  private saveIntents(): void {
    this.db.save();
  }

  private dropIntent(key: string): void {
    this.intents.delete(key);
    if (this.db.pendingIntents[key]) {
      delete this.db.pendingIntents[key];
      this.db.save();
    }
  }

  private key(accountId: string, market: MarketType, symbol?: string): string {
    return symbol ? `${accountId}:${market}:${symbol}` : `${accountId}:${market}`;
  }

  /** Whether this account trades futures in dual-side (hedge) mode. */
  isHedge(accountId: string, market: MarketType): boolean {
    if (market !== 'futures') return false;
    return this.db.settings.accounts.find((a) => a.id === accountId)?.hedgeMode === true;
  }

  /** Intents are per pair in one-way mode, per pair+side in hedge mode. */
  private intentKey(accountId: string, market: MarketType, symbol: string, dir: PositionDir): string {
    const base = this.key(accountId, market, symbol);
    return this.isHedge(accountId, market) ? `${base}:${dir}` : base;
  }

  /** Hedge orders carry the position side; one-way closing orders reduceOnly. */
  private closeParams(pos: ManagedPosition): { reduceOnly?: boolean; positionSide?: 'LONG' | 'SHORT' } {
    if (this.isHedge(pos.accountId, pos.market)) {
      return { positionSide: pos.side === 'long' ? 'LONG' : 'SHORT' };
    }
    return { reduceOnly: pos.market === 'futures' };
  }

  /** Drop adapters for an account so config changes (hedge mode) re-apply. */
  async resetAccount(accountId: string): Promise<void> {
    for (const [key, adapter] of [...this.adapters]) {
      if (key.startsWith(`${accountId}:`)) {
        await adapter.close().catch(() => {});
        this.adapters.delete(key);
      }
    }
  }

  async adapter(accountId: string, market: MarketType): Promise<ExchangeAdapter> {
    const k = this.key(accountId, market);
    let a = this.adapters.get(k);
    if (!a) {
      a = await this.adapterFactory(accountId, market);
      await a.setPositionMode(this.isHedge(accountId, market)).catch((e) =>
        this.log('error', `position mode sync failed for ${accountId}: ${e}`),
      );
      this.adapters.set(k, a);
      // Serialize fills per symbol so concurrent events can't interleave
      // position updates.
      a.onFill((fill) => {
        const qk = this.key(accountId, market, fill.symbol);
        const prev = this.fillQueues.get(qk) ?? Promise.resolve();
        const next = prev
          .then(() => this.handleFill(a!, fill))
          .catch((e) => this.log('error', `fill handling failed: ${e}`));
        this.fillQueues.set(qk, next);
      });
      a.onPrice((symbol, price) => {
        void this.handlePriceTick(a!, symbol, price);
        this.priceListeners.forEach((cb) => cb(symbol, price));
      });
      a.onCandleClose((symbol, interval, candle) =>
        void this.handleCandleClose(a!, symbol, interval, candle.close).catch((e) =>
          this.log('error', `candle close handling failed: ${e}`),
        ),
      );
      // Watch prices/candles for existing open positions after a restart.
      for (const p of this.db.openPositions(accountId)) {
        if (p.market !== market) continue;
        a.watchPrice(p.symbol);
        if (p.slCandleTf) a.watchCandles(p.symbol, p.slCandleTf);
        const slx = p.config.slx;
        if (slx.enabled && slx.trigger === 'candle') a.watchCandles(p.symbol, slx.candleTf ?? '1m');
      }
    }
    return a;
  }

  /** Price ticks from every adapter (for the UI websocket). */
  onAnyPrice(cb: (symbol: string, price: number) => void): void {
    this.priceListeners.push(cb);
  }

  /** Wait until all queued fill events have been processed. */
  async settle(): Promise<void> {
    await Promise.all([...this.fillQueues.values()]);
  }

  private log(level: 'info' | 'error', message: string): void {
    this.emit('log', { level, message, time: Date.now() });
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : 'log'](`[engine] ${message}`);
  }

  private changed(): void {
    this.emit('changed');
  }

  // ------------------------------------------------------------------
  // Signals
  // ------------------------------------------------------------------

  async handleSignal(hookId: string, body: unknown, sourceIp: string): Promise<SignalLogEntry> {
    const logBase = { receivedAt: Date.now(), sourceIp, payload: body };
    const hook = this.db.hookById(hookId);
    if (!hook) {
      return this.db.addSignalLog({
        ...logBase, hookId, hookName: '?', action: 'ignore', detail: 'Unknown hook', ok: false,
      });
    }
    const finish = (action: SignalLogEntry['action'], detail: string, ok: boolean): SignalLogEntry => {
      const entry = this.db.addSignalLog({ ...logBase, hookId, hookName: hook.name, action, detail, ok });
      this.changed();
      return entry;
    };

    const allowedIps = this.db.settings.allowedSignalIps;
    if (allowedIps.length > 0 && !allowedIps.includes(sourceIp)) {
      return finish('ignore', `Source IP ${sourceIp} not allowed`, false);
    }
    if (!hook.enabled) return finish('ignore', 'Hook disabled', false);

    let signal: Signal;
    try {
      signal = parseSignal(body);
    } catch (e) {
      return finish('ignore', e instanceof SignalError ? e.message : String(e), false);
    }
    if (signal.secret !== hook.secret) return finish('ignore', 'Invalid secret', false);

    const symbol = hook.fixedSymbol || signal.symbol;
    const h = effectiveHook(hook, signal);

    if (h.open.blacklist.includes(symbol)) return finish('ignore', `${symbol} blacklisted`, true);
    if (h.open.whitelist.length > 0 && !h.open.whitelist.includes(symbol)) {
      return finish('ignore', `${symbol} not whitelisted`, true);
    }

    const adapter = await this.adapter(hook.accountId, hook.market);
    const info = await adapter.symbolInfo(symbol);
    if (!info) return finish('ignore', `Unknown symbol ${symbol}`, false);

    const hedge = this.isHedge(hook.accountId, hook.market);
    const sigWithSymbol = { ...signal, symbol };
    const side = hedge ? relevantSide(h, sigWithSymbol) : undefined;
    const position = this.db.openPositionFor(hook.accountId, hook.market, symbol, side);
    const decision = decide(h, sigWithSymbol, position, hedge);

    try {
      switch (decision.action) {
        case 'ignore':
          return finish('ignore', decision.reason, true);
        case 'open': {
          const detail = await this.executeOpen(adapter, h, info, decision.dir, signal);
          return finish('open', detail, !detail.startsWith('skipped'));
        }
        case 'dca': {
          const detail = await this.executeDca(adapter, h, info, position!, signal);
          return finish('dca', detail, !detail.startsWith('skipped'));
        }
        case 'close': {
          // "flat" in hedge mode closes both sides of the pair.
          if (hedge && signal.positionSide === 'flat') {
            const targets = this.db
              .openPositions(hook.accountId)
              .filter((p) => p.market === hook.market && p.symbol === symbol);
            for (const p of targets) await this.closePositionMarket(adapter, p, 1);
            return finish('close', `flat: closed ${targets.length} side(s) of ${symbol}`, true);
          }
          const detail = await this.executeClose(adapter, h, info, position!, signal, false);
          return finish('close', detail, !detail.startsWith('skipped'));
        }
        case 'reverse': {
          const detail = await this.executeClose(adapter, h, info, position!, signal, true);
          return finish('reverse', detail, !detail.startsWith('skipped'));
        }
        case 'update_tp': {
          const detail = await this.executeTpUpdate(adapter, h, info, position!, signal);
          return finish('update_tp', detail, true);
        }
        default:
          return finish('ignore', 'Unhandled action', false);
      }
    } catch (e) {
      return finish(decision.action, `Error: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  }

  private snapshotConfig(h: Hook): ManagedPosition['config'] {
    return structuredClone({ tp: h.tp, sl: h.sl, slx: h.slx });
  }

  private async amountCtx(
    adapter: ExchangeAdapter,
    info: SymbolInfo,
    leverage: number,
    refPrice: number,
    position?: ManagedPosition,
  ): Promise<AmountCtx> {
    const balances = await adapter.getBalances();
    const quoteBal = balances.find((b) => b.asset === info.quote);
    let freeBalance = quoteBal?.free ?? 0;
    let fullBalance: number;
    // Prefer the exchange's authoritative totals (correct across multi-asset
    // collateral and unrealized PnL). Fall back to summing the quote balance
    // + position PnL when the market can't report them (spot).
    const eq = await adapter.accountEquity().catch(() => null);
    if (eq) {
      freeBalance = eq.available;
      fullBalance = eq.equity;
    } else {
      let pnl = 0;
      for (const p of await adapter.getPositions()) pnl += p.unrealizedPnl;
      // Futures: quote free+locked is the wallet balance (margin used is
      // "locked"); adding uPnL gives account equity. Spot: total quote cash.
      const wallet = balances.reduce((s, b) => s + (b.asset === info.quote ? b.free + b.locked : 0), 0);
      fullBalance = wallet + pnl;
    }
    return {
      price: refPrice,
      leverage,
      freeBalance,
      fullBalance,
      positionQty: position?.qty,
      positionEntryPrice: position?.entryPrice,
    };
  }

  private async refPrice(adapter: ExchangeAdapter, symbol: string, signal?: Signal): Promise<number> {
    if (signal?.price && signal.price > 0) return signal.price;
    return adapter.getPrice(symbol);
  }

  private entryOrderParams(
    type: 'market' | 'limit' | 'stop_market',
    dir: PositionDir,
    refPrice: number,
    offsetPct: number,
  ): { type: 'MARKET' | 'LIMIT' | 'STOP_MARKET'; price?: number; stopPrice?: number } {
    if (type === 'market') return { type: 'MARKET' };
    // Buy entries improve below the reference, sell entries above.
    const sign = dir === 'long' ? -1 : 1;
    const price = refPrice * (1 + (sign * offsetPct) / 100);
    if (type === 'limit') return { type: 'LIMIT', price };
    return { type: 'STOP_MARKET', stopPrice: refPrice * (1 - (sign * offsetPct) / 100) };
  }

  private async executeOpen(
    adapter: ExchangeAdapter,
    h: Hook,
    info: SymbolInfo,
    dir: PositionDir,
    signal?: Signal,
  ): Promise<string> {
    if (h.market === 'spot' && dir === 'short') return 'skipped: cannot short on spot';

    // Limits.
    const o = h.open;
    const key = this.key(h.accountId, h.market, info.symbol);
    if (o.timeoutMin > 0) {
      const last = this.db.lastCloseAt[key] ?? 0;
      if (Date.now() - last < o.timeoutMin * 60_000) return 'skipped: open timeout in effect';
    }
    const open = this.db.openPositions(h.accountId);
    if (o.maxOpenPositions > 0 && open.length >= o.maxOpenPositions) return 'skipped: max open positions';
    const hookOpen = open.filter((p) => p.hookId === h.id);
    if (o.maxHookPositions > 0 && hookOpen.length >= o.maxHookPositions) return 'skipped: max hook positions';

    const price = await this.refPrice(adapter, info.symbol, signal);
    const ctx = await this.amountCtx(adapter, info, o.leverage, price);
    const rawQty = computeBaseQty(o.amount, ctx);
    const totalVolume = open.reduce((s, p) => s + p.qty * p.entryPrice, 0);
    if (o.maxTotalVolumeUsd > 0 && totalVolume + rawQty * price > o.maxTotalVolumeUsd) {
      return 'skipped: max total volume';
    }
    const hookVolume = hookOpen.reduce((s, p) => s + p.qty * p.entryPrice, 0);
    if (o.maxHookVolumeUsd > 0 && hookVolume + rawQty * price > o.maxHookVolumeUsd) {
      return 'skipped: max hook volume';
    }

    const q = quantizeOrder(info, rawQty, price);
    if (!q) return `skipped: qty ${rawQty} below exchange minimum`;

    if (h.market === 'futures') {
      await adapter.setLeverage(info.symbol, o.leverage).catch(() => {});
      await adapter.setMarginMode(info.symbol, o.marginMode).catch(() => {});
    }

    const hedge = this.isHedge(h.accountId, h.market);
    const positionSide = hedge ? (dir === 'long' ? 'LONG' : 'SHORT') : undefined;
    const ikey = this.intentKey(h.accountId, h.market, info.symbol, dir);
    const intent: PendingIntent = {
      accountId: h.accountId,
      market: h.market,
      symbol: info.symbol,
      dir,
      hookId: h.id,
      leverage: o.leverage,
      marginMode: o.marginMode,
      config: this.snapshotConfig(h),
      createdAt: Date.now(),
    };
    this.setIntent(ikey, intent);
    adapter.watchPrice(info.symbol);

    try {
      if (o.entry === 'grid') {
        const levels = planGrid(o.grid ?? defaultGridConfig(), dir, price, rawQty, info);
        if (levels.length === 0) {
          this.dropIntent(ikey);
          return 'skipped: no grid orders above exchange minimums';
        }
        intent.entryOrderIds = [];
        for (const lvl of levels) {
          const res = await adapter.placeOrder({
            symbol: info.symbol,
            side: dir === 'long' ? 'BUY' : 'SELL',
            type: 'LIMIT',
            qty: lvl.qty,
            price: lvl.price,
            positionSide,
          });
          intent.entryOrderIds.push(res.orderId);
        }
        this.saveIntents();
        // A marketable grid level may have filled during placement and
        // consumed the intent — carry the remaining order ids to the position.
        if (!this.intents.has(ikey)) {
          const pos = this.db.openPositionFor(h.accountId, h.market, info.symbol, hedge ? dir : undefined);
          if (pos) {
            pos.entryOrderIds = [...new Set([...(pos.entryOrderIds ?? []), ...intent.entryOrderIds])];
            this.db.upsertPosition(pos);
          }
        }
        this.scheduleReconcile(h.accountId, h.market);
        return `open ${dir} grid ${levels.length} orders / ${rawQty.toPrecision(6)} ${info.symbol}`;
      }
      const params = this.entryOrderParams(o.orderType, dir, price, o.priceOffsetPct);
      const res = await adapter.placeOrder({
        symbol: info.symbol,
        side: dir === 'long' ? 'BUY' : 'SELL',
        qty: q.qty,
        positionSide,
        ...params,
      });
      this.scheduleReconcile(h.accountId, h.market);
      return `open ${dir} ${q.qty} ${info.symbol} @ ${params.type} (order ${res.orderId}, ${res.status})`;
    } catch (e) {
      this.dropIntent(ikey);
      throw e;
    }
  }

  private async executeDca(
    adapter: ExchangeAdapter,
    h: Hook,
    info: SymbolInfo,
    position: ManagedPosition,
    signal?: Signal,
  ): Promise<string> {
    const d = h.dca;
    if (!d.allowWithOpenDcaOrders) {
      const orders = await adapter.getOpenOrders(info.symbol);
      if (orders.some((x) => !x.reduceOnly)) return 'skipped: open averaging orders exist';
    }
    const price = await this.refPrice(adapter, info.symbol, signal);
    const ctx = await this.amountCtx(adapter, info, position.leverage, price, position);
    const rawQty = computeBaseQty(d.amount, ctx);
    if (d.maxPositionVolumeUsd > 0) {
      const projected = position.qty * position.entryPrice + rawQty * price;
      if (projected > d.maxPositionVolumeUsd) return 'skipped: max position volume';
    }
    const q = quantizeOrder(info, rawQty, price);
    if (!q) return `skipped: qty ${rawQty} below exchange minimum`;

    // Refresh the position's lifecycle config so reordering uses new settings.
    position.config = this.snapshotConfig(h);
    this.db.upsertPosition(position);

    const positionSide = this.isHedge(h.accountId, h.market)
      ? position.side === 'long'
        ? 'LONG'
        : 'SHORT'
      : undefined;

    if (d.entry === 'grid') {
      const levels = planGrid(d.grid ?? defaultGridConfig(), position.side, price, rawQty, info);
      if (levels.length === 0) return 'skipped: no grid orders above exchange minimums';
      const ids: string[] = [];
      for (const lvl of levels) {
        const res = await adapter.placeOrder({
          symbol: info.symbol,
          side: position.side === 'long' ? 'BUY' : 'SELL',
          type: 'LIMIT',
          qty: lvl.qty,
          price: lvl.price,
          positionSide,
        });
        ids.push(res.orderId);
      }
      position.entryOrderIds = [...new Set([...(position.entryOrderIds ?? []), ...ids])];
      this.db.upsertPosition(position);
      return `dca ${position.side} grid ${levels.length} orders / ${rawQty.toPrecision(6)} ${info.symbol}`;
    }

    const params = this.entryOrderParams(d.orderType, position.side, price, d.priceOffsetPct);
    const res = await adapter.placeOrder({
      symbol: info.symbol,
      side: position.side === 'long' ? 'BUY' : 'SELL',
      qty: q.qty,
      positionSide,
      ...params,
    });
    return `dca ${position.side} +${q.qty} ${info.symbol} (order ${res.orderId}, ${res.status})`;
  }

  private async executeClose(
    adapter: ExchangeAdapter,
    h: Hook,
    info: SymbolInfo,
    position: ManagedPosition,
    signal: Signal | undefined,
    reverse: boolean,
  ): Promise<string> {
    const c = h.close;
    const mark = await adapter.getPrice(info.symbol);
    if (c.checkProfit && !reverse) {
      const profitable = position.side === 'long' ? mark > position.entryPrice : mark < position.entryPrice;
      if (!profitable) return 'skipped: check-profit (position not in profit)';
    }

    // Bulk close.
    if (c.closeAll !== 'off' && !reverse) {
      const targets = this.db
        .openPositions(h.accountId)
        .filter((p) => p.market === h.market && (c.closeAll === 'both' || p.side === c.closeAll));
      for (const p of targets) {
        await this.closePositionMarket(adapter, p, 1);
      }
      return `close_all: closed ${targets.length} positions`;
    }

    let closeQty = position.qty;
    if (c.mode === 'signal_amount' && !reverse) {
      const ctx = await this.amountCtx(adapter, info, position.leverage, mark, position);
      closeQty = Math.min(position.qty, computeBaseQty(c.amount, ctx));
    }

    let extraQty = 0;
    const newDir: PositionDir = position.side === 'long' ? 'short' : 'long';
    if (reverse) {
      // Reverse: close the position and open the opposite side using the
      // open module's amount in one order (one-way futures only).
      const price = await this.refPrice(adapter, info.symbol, signal);
      const ctx = await this.amountCtx(adapter, info, h.open.leverage, price);
      extraQty = computeBaseQty(h.open.amount, ctx);
      closeQty = position.qty;
      this.setIntent(this.intentKey(h.accountId, h.market, info.symbol, newDir), {
        accountId: h.accountId,
        market: h.market,
        symbol: info.symbol,
        dir: newDir,
        hookId: h.id,
        leverage: h.open.leverage,
        marginMode: h.open.marginMode,
        config: this.snapshotConfig(h),
        createdAt: Date.now(),
      });
    }

    const total = quantizeQty(info, closeQty + extraQty);
    if (total <= 0) return 'skipped: close quantity below minimum';
    const side = position.side === 'long' ? 'SELL' : 'BUY';
    try {
      const res = await adapter.placeOrder({
        symbol: info.symbol,
        side,
        type: c.orderType === 'limit' ? 'LIMIT' : 'MARKET',
        price: c.orderType === 'limit' ? mark : undefined,
        qty: total,
        ...(reverse ? {} : this.closeParams(position)),
      });
      return `${reverse ? 'reverse' : 'close'} ${side} ${total} ${info.symbol} (order ${res.orderId}, ${res.status})`;
    } catch (e) {
      if (reverse) this.dropIntent(this.intentKey(h.accountId, h.market, info.symbol, newDir));
      throw e;
    }
  }

  private async executeTpUpdate(
    adapter: ExchangeAdapter,
    h: Hook,
    info: SymbolInfo,
    position: ManagedPosition,
    signal: Signal,
  ): Promise<string> {
    const orders = signalTpOrders(signal);
    if (orders.length === 0) return 'TP update: no valid levels in signal';
    position.config.tp = { ...position.config.tp, enabled: true, orders };
    this.db.upsertPosition(position);
    await this.replaceTpOrders(adapter, position, info);
    this.changed();
    return `TP update: ${orders.length} levels`;
  }

  // ------------------------------------------------------------------
  // Manual trading (UI order panel)
  // ------------------------------------------------------------------

  async manualOrder(input: ManualOrderInput): Promise<string> {
    const adapter = await this.adapter(input.accountId, input.market);
    const info = await adapter.symbolInfo(input.symbol);
    if (!info) throw new Error(`Unknown symbol ${input.symbol}`);
    const price = input.price ?? (await adapter.getPrice(input.symbol));

    const dir: PositionDir = input.side === 'buy' ? 'long' : 'short';
    const hedge = this.isHedge(input.accountId, input.market);

    // Resolve the size. `amount` (e.g. % of portfolio) is computed server-side
    // against live balances/positions so it's authoritative; otherwise use the
    // explicit base quantity.
    let baseQty = input.qty ?? 0;
    if (input.amount) {
      const position = this.db.openPositionFor(input.accountId, input.market, input.symbol, hedge ? dir : undefined);
      const ctx = await this.amountCtx(adapter, info, input.leverage ?? 1, price, position);
      baseQty = computeBaseQty(input.amount, ctx);
    }
    if (!(baseQty > 0)) throw new Error('Order size resolves to zero — check the amount/balance');
    const q = quantizeOrder(info, baseQty, price);
    if (!q) throw new Error(`Quantity ${baseQty} is below the exchange minimum`);
    // In hedge mode a reducing buy closes the short side, a reducing sell
    // the long side; opening orders act on their own side.
    const positionSide = hedge
      ? input.reduceOnly
        ? input.side === 'buy'
          ? 'SHORT'
          : 'LONG'
        : dir === 'long'
          ? 'LONG'
          : 'SHORT'
      : undefined;
    if (input.market === 'futures') {
      if (input.leverage) await adapter.setLeverage(input.symbol, input.leverage).catch(() => {});
      if (input.marginMode) await adapter.setMarginMode(input.symbol, input.marginMode).catch(() => {});
    }
    // Spot sells reduce holdings — never an opening intent for a "short".
    const opensPosition = !input.reduceOnly && !(input.market === 'spot' && input.side === 'sell');
    const ikey = this.intentKey(input.accountId, input.market, input.symbol, dir);
    let intent: PendingIntent | undefined;
    if (opensPosition) {
      intent = {
        accountId: input.accountId,
        market: input.market,
        symbol: input.symbol,
        dir,
        hookId: undefined,
        leverage: input.leverage ?? 1,
        marginMode: input.marginMode ?? 'cross',
        config: {
          tp: input.tp ?? { ...defaultTpModule(), enabled: false },
          sl: input.sl ?? { ...defaultSlModule(), enabled: false },
          slx: input.slx ?? { ...defaultSlxModule(), enabled: false },
        },
        createdAt: Date.now(),
      };
      this.setIntent(ikey, intent);
      adapter.watchPrice(input.symbol);
    }

    try {
      if (input.grid && opensPosition) {
        const levels = planGrid(input.grid, dir, price, baseQty, info);
        if (levels.length === 0) throw new Error('No grid orders above the exchange minimums');
        intent!.entryOrderIds = [];
        for (const lvl of levels) {
          const res = await adapter.placeOrder({
            symbol: input.symbol,
            side: input.side === 'buy' ? 'BUY' : 'SELL',
            type: 'LIMIT',
            qty: lvl.qty,
            price: lvl.price,
            positionSide,
          });
          intent!.entryOrderIds.push(res.orderId);
        }
        this.saveIntents();
        if (!this.intents.has(ikey)) {
          const pos = this.db.openPositionFor(input.accountId, input.market, input.symbol, hedge ? dir : undefined);
          if (pos) {
            pos.entryOrderIds = [...new Set([...(pos.entryOrderIds ?? []), ...intent!.entryOrderIds])];
            this.db.upsertPosition(pos);
          }
        }
        this.scheduleReconcile(input.accountId, input.market);
        this.changed();
        return `grid:${levels.length}`;
      }
      const res = await adapter.placeOrder({
        symbol: input.symbol,
        side: input.side === 'buy' ? 'BUY' : 'SELL',
        type: input.type === 'market' ? 'MARKET' : input.type === 'limit' ? 'LIMIT' : 'STOP_MARKET',
        qty: q.qty,
        price: input.type === 'limit' ? q.price : undefined,
        stopPrice: input.type === 'stop_market' ? input.stopPrice ?? q.price : undefined,
        reduceOnly: input.reduceOnly && input.market === 'futures' && !hedge,
        positionSide,
      });
      if (opensPosition) this.scheduleReconcile(input.accountId, input.market);
      this.changed();
      return res.orderId;
    } catch (e) {
      if (opensPosition) this.dropIntent(ikey);
      throw e;
    }
  }

  async closeManagedPosition(positionId: string, fraction = 1): Promise<void> {
    const pos = this.db.positions.find((p) => p.id === positionId && p.status === 'open');
    if (!pos) throw new Error('Position not found');
    const adapter = await this.adapter(pos.accountId, pos.market);
    await this.closePositionMarket(adapter, pos, fraction);
  }

  private async closePositionMarket(adapter: ExchangeAdapter, pos: ManagedPosition, fraction: number): Promise<void> {
    const info = await adapter.symbolInfo(pos.symbol);
    if (!info) throw new Error(`Unknown symbol ${pos.symbol}`);
    const qty = quantizeQty(info, pos.qty * Math.min(1, Math.max(0, fraction)));
    if (qty <= 0) return;
    await adapter.placeOrder({
      symbol: pos.symbol,
      side: pos.side === 'long' ? 'SELL' : 'BUY',
      type: 'MARKET',
      qty,
      ...this.closeParams(pos),
    });
  }

  /**
   * Reprice a resting order by cancel-and-replace, preserving its side, type,
   * remaining quantity and (for managed TP/SL/entry orders) its link to the
   * managed position. Used by chart drag-to-move. Serialized with fills so a
   * fill can't interleave with the cancel/replace.
   */
  async moveOrder(accountId: string, market: MarketType, symbol: string, orderId: string, newPrice: number): Promise<string> {
    const adapter = await this.adapter(accountId, market);
    const info = await adapter.symbolInfo(symbol);
    if (!info) throw new Error(`Unknown symbol ${symbol}`);
    const price = quantizePrice(info, newPrice);
    if (!(price > 0)) throw new Error('Invalid target price');
    const hedge = this.isHedge(accountId, market);

    const qk = this.key(accountId, market, symbol);
    const prev = this.fillQueues.get(qk) ?? Promise.resolve();
    let newId = '';
    const next = prev.then(async () => {
      const orders = await adapter.getOpenOrders(symbol);
      const o = orders.find((x) => x.orderId === orderId);
      if (!o) throw new Error('Order not found (it may have filled or been cancelled)');
      const remaining = o.origQty - o.executedQty;
      if (!(remaining > 0)) throw new Error('Order already filled');
      const usesStop = o.stopPrice > 0; // SL/stop orders carry a stopPrice; TP/entries are limits

      // Find the managed position this order belongs to and its role, so the
      // replacement keeps the right reduce-only / positionSide and re-links.
      const pos = this.db
        .openPositions(accountId)
        .find(
          (p) =>
            p.market === market &&
            p.symbol === symbol &&
            (p.tpOrderIds.includes(orderId) || p.slOrderId === orderId || (p.entryOrderIds ?? []).includes(orderId)),
        );
      const role: 'tp' | 'sl' | 'entry' | 'none' = !pos
        ? 'none'
        : pos.slOrderId === orderId
          ? 'sl'
          : pos.tpOrderIds.includes(orderId)
            ? 'tp'
            : 'entry';

      let extra: { reduceOnly?: boolean; positionSide?: 'LONG' | 'SHORT' } = {};
      if (pos && (role === 'tp' || role === 'sl')) extra = this.closeParams(pos);
      else if (pos && role === 'entry') extra = hedge ? { positionSide: pos.side === 'long' ? 'LONG' : 'SHORT' } : {};
      else extra = { reduceOnly: o.reduceOnly && market === 'futures' && !hedge };

      await adapter.cancelOrder(symbol, orderId);
      const placed = await adapter.placeOrder({
        symbol,
        side: o.side,
        type: usesStop ? 'STOP_MARKET' : 'LIMIT',
        qty: remaining,
        price: usesStop ? undefined : price,
        stopPrice: usesStop ? price : undefined,
        ...extra,
      });
      newId = placed.orderId;

      // Re-link the new order id on the managed position.
      if (pos) {
        if (role === 'tp') {
          const idx = pos.tpOrderIds.indexOf(orderId);
          pos.tpOrderIds = pos.tpOrderIds.map((id) => (id === orderId ? newId : id));
          if (pos.tpLevels && idx >= 0 && idx < pos.tpLevels.length) pos.tpLevels[idx].price = price;
        } else if (role === 'sl') {
          pos.slOrderId = newId;
          pos.slPrice = price;
        } else if (role === 'entry') {
          pos.entryOrderIds = (pos.entryOrderIds ?? []).map((id) => (id === orderId ? newId : id));
        }
        this.db.upsertPosition(pos);
      }
      this.log('info', `moved ${role} order ${symbol} ${orderId} → ${newId} @ ${price}`);
      this.changed();
    });
    this.fillQueues.set(qk, next);
    await next;
    return newId;
  }

  // ------------------------------------------------------------------
  // Fill handling → position lifecycle
  // ------------------------------------------------------------------

  private async handleFill(adapter: ExchangeAdapter, fill: FillEvent): Promise<void> {
    const { accountId, market } = adapter;
    const hedge = this.isHedge(accountId, market);
    const fillDir: PositionDir = fill.side === 'BUY' ? 'long' : 'short';
    // Hedge fills name their dual-position side; look up that side only.
    const posSide: PositionDir | undefined = hedge
      ? fill.positionSide === 'SHORT'
        ? 'short'
        : 'long'
      : undefined;
    let pos = this.db.openPositionFor(accountId, market, fill.symbol, posSide);
    const ikey = this.intentKey(accountId, market, fill.symbol, posSide ?? fillDir);

    if (!pos) {
      const intent = this.intents.get(ikey);
      if (!intent || intent.dir !== fillDir) return; // external or stale fill
      pos = this.createPosition(accountId, market, fill, intent);
      this.dropIntent(ikey);
      this.log('info', `position opened: ${pos.side} ${pos.qty} ${pos.symbol} @ ${pos.entryPrice}`);
      await this.applyProtection(adapter, pos);
      this.changed();
      return;
    }

    if (fillDir === pos.side) {
      // Averaging fill: grow position, recompute average, reorder TP/SL.
      if (pos.entryOrderIds?.includes(fill.orderId)) {
        pos.entryOrderIds = pos.entryOrderIds.filter((id) => id !== fill.orderId);
      }
      const total = pos.qty + fill.qty;
      pos.entryPrice = (pos.entryPrice * pos.qty + fill.price * fill.qty) / total;
      pos.qty = Number(total.toFixed(10));
      pos.dcaCount += 1;
      this.db.upsertPosition(pos);
      this.log('info', `position averaged: ${pos.side} ${pos.qty} ${pos.symbol} @ ${pos.entryPrice}`);
      await this.applyProtection(adapter, pos, true);
      this.changed();
      return;
    }

    // Reducing fill.
    const reduce = Math.min(pos.qty, fill.qty);
    const dirSign = pos.side === 'long' ? 1 : -1;
    pos.realizedPnl += (fill.price - pos.entryPrice) * reduce * dirSign;
    pos.qty = Number((pos.qty - reduce).toFixed(10));

    if (pos.tpOrderIds.includes(fill.orderId)) {
      pos.tpOrderIds = pos.tpOrderIds.filter((id) => id !== fill.orderId);
      pos.tpFilledCount += 1;
      await this.maybeMoveBreakeven(adapter, pos);
    }

    if (pos.qty > 0) {
      this.db.upsertPosition(pos);
      this.changed();
    } else {
      await this.cancelProtection(adapter, pos);
      this.db.markClosed(pos, pos.realizedPnl);
      this.log('info', `position closed: ${pos.symbol} PnL ${pos.realizedPnl.toFixed(4)}`);
      this.changed();
      // Remainder of a reversal fill opens the opposite position (one-way
      // mode only — hedge positions never flip through zero).
      const rest = fill.qty - reduce;
      const rkey = this.intentKey(accountId, market, fill.symbol, fillDir);
      const intent = this.intents.get(rkey);
      if (!hedge && rest > 0 && intent && intent.dir === fillDir) {
        const newPos = this.createPosition(accountId, market, { ...fill, qty: rest }, intent);
        this.dropIntent(rkey);
        this.log('info', `position reversed: now ${newPos.side} ${newPos.qty} ${newPos.symbol}`);
        await this.applyProtection(adapter, newPos);
        this.changed();
      }
    }
  }

  /** Build a fresh managed-position record (unsaved). */
  private newManagedPosition(fields: {
    accountId: string;
    market: MarketType;
    symbol: string;
    side: PositionDir;
    qty: number;
    entryPrice: number;
    leverage: number;
    marginMode: 'cross' | 'isolated';
    hookId?: string;
    config: ManagedPosition['config'];
    entryOrderIds?: string[];
  }): ManagedPosition {
    return {
      id: randomUUID(),
      ...fields,
      openedAt: Date.now(),
      status: 'open',
      realizedPnl: 0,
      dcaCount: 0,
      tpOrderIds: [],
      tpFilledCount: 0,
    };
  }

  private createPosition(
    accountId: string,
    market: MarketType,
    fill: FillEvent,
    intent: PendingIntent,
  ): ManagedPosition {
    const pos = this.newManagedPosition({
      accountId,
      market,
      symbol: fill.symbol,
      side: intent.dir,
      qty: fill.qty,
      entryPrice: fill.price,
      leverage: intent.leverage,
      marginMode: intent.marginMode,
      hookId: intent.hookId,
      config: intent.config,
      entryOrderIds: intent.entryOrderIds?.filter((id) => id !== fill.orderId),
    });
    this.db.upsertPosition(pos);
    return pos;
  }

  /**
   * Attach (or replace) a TP grid + SL on a position that already exists on the
   * exchange — including one opened before the terminal, or before this fix,
   * that shows as "not managed". Creates the managed record from the live
   * exchange position when needed, then places the protective orders.
   */
  async manageExistingPosition(input: {
    accountId: string;
    market: MarketType;
    symbol: string;
    side?: PositionDir;
    tp?: ManagedPosition['config']['tp'];
    sl?: ManagedPosition['config']['sl'];
    slx?: ManagedPosition['config']['slx'];
  }): Promise<string> {
    const adapter = await this.adapter(input.accountId, input.market);
    const info = await adapter.symbolInfo(input.symbol);
    if (!info) throw new Error(`Unknown symbol ${input.symbol}`);
    if (input.market !== 'futures') throw new Error('Managing a position requires a futures market');
    const hedge = this.isHedge(input.accountId, input.market);
    const positions = await adapter.getPositions();
    const matches = positions.filter(
      (p) =>
        p.symbol === input.symbol &&
        Math.abs(p.qty) > 1e-12 &&
        (input.side
          ? hedge
            ? p.positionSide === (input.side === 'long' ? 'LONG' : 'SHORT')
            : (p.qty > 0) === (input.side === 'long')
          : true),
    );
    if (matches.length === 0) throw new Error(`No open ${input.symbol} position to manage`);
    if (matches.length > 1) throw new Error(`Multiple ${input.symbol} positions — specify a side`);
    const exPos = matches[0];
    const dir: PositionDir = hedge
      ? exPos.positionSide === 'SHORT'
        ? 'short'
        : 'long'
      : exPos.qty > 0
        ? 'long'
        : 'short';
    const config: ManagedPosition['config'] = {
      tp: input.tp ?? { ...defaultTpModule(), enabled: false },
      sl: input.sl ?? { ...defaultSlModule(), enabled: false },
      slx: input.slx ?? { ...defaultSlxModule(), enabled: false },
    };

    const qk = this.key(input.accountId, input.market, input.symbol);
    const prev = this.fillQueues.get(qk) ?? Promise.resolve();
    let detail = '';
    const next = prev
      .then(async () => {
        let pos = this.db.openPositionFor(input.accountId, input.market, input.symbol, hedge ? dir : undefined);
        if (pos) {
          // Already managed: swap in the new protection and re-sync size.
          pos.config = config;
          pos.qty = Math.abs(exPos.qty);
          pos.entryPrice = exPos.entryPrice;
          pos.trailing = undefined;
          this.db.upsertPosition(pos);
          await this.applyProtection(adapter, pos);
          detail = `updated protection for ${pos.side} ${pos.symbol}`;
        } else {
          pos = this.newManagedPosition({
            accountId: input.accountId,
            market: input.market,
            symbol: input.symbol,
            side: dir,
            qty: Math.abs(exPos.qty),
            entryPrice: exPos.entryPrice,
            leverage: exPos.leverage || 1,
            marginMode: exPos.marginMode,
            config,
          });
          this.db.upsertPosition(pos);
          this.dropIntent(this.intentKey(input.accountId, input.market, input.symbol, dir));
          adapter.watchPrice(pos.symbol);
          await this.applyProtection(adapter, pos);
          detail = `now managing ${pos.side} ${pos.qty} ${pos.symbol}`;
        }
        this.changed();
      })
      .catch((e) => {
        detail = `error: ${e instanceof Error ? e.message : String(e)}`;
        throw e;
      });
    this.fillQueues.set(qk, next);
    await next;
    return detail;
  }

  /** Place/replace TP grid and SL for a position. */
  private async applyProtection(adapter: ExchangeAdapter, pos: ManagedPosition, afterDca = false): Promise<void> {
    const info = await adapter.symbolInfo(pos.symbol);
    if (!info) return;
    await this.replaceTpOrders(adapter, pos, info, afterDca);
    await this.replaceSlOrder(adapter, pos, info, afterDca);
    const slx = pos.config.slx;
    if (slx.enabled && slx.trigger === 'candle') {
      adapter.watchCandles(pos.symbol, slx.candleTf ?? '1m');
    }
    this.db.upsertPosition(pos);
  }

  private async replaceTpOrders(
    adapter: ExchangeAdapter,
    pos: ManagedPosition,
    info: SymbolInfo,
    afterDca = false,
  ): Promise<void> {
    const tp = pos.config.tp;
    const prevLevels = pos.tpLevels;
    // Cancel existing TP orders.
    for (const id of pos.tpOrderIds) {
      await adapter.cancelOrder(pos.symbol, id).catch(() => {});
    }
    pos.tpOrderIds = [];
    pos.virtualTp = undefined;
    pos.tpLevels = undefined;
    if (!tp.enabled) return;

    // Level reordering (Finandy): keep % distances from the NEW average price
    // when enabled; when disabled after DCA, keep the previous absolute
    // prices with quantities recomputed for the grown position.
    let orders = planTpOrders(tp, pos.side, pos.entryPrice, pos.qty, info);
    if (afterDca && !tp.reorderLevels && prevLevels?.length) {
      orders = orders.map((o, i) => ({
        ...o,
        price: prevLevels[Math.min(i, prevLevels.length - 1)].price,
      }));
    }
    if (orders.length === 0) return;
    pos.tpLevels = orders.map((o) => ({ price: o.price, qty: o.qty }));

    if (tp.orderType === 'limit') {
      for (const o of orders) {
        const res = await adapter
          .placeOrder({
            symbol: pos.symbol,
            side: pos.side === 'long' ? 'SELL' : 'BUY',
            type: 'LIMIT',
            qty: o.qty,
            price: o.price,
            ...this.closeParams(pos),
          })
          .catch((e) => {
            this.log('error', `TP order failed for ${pos.symbol}: ${e}`);
            return null;
          });
        if (res) pos.tpOrderIds.push(res.orderId);
      }
    } else {
      // Virtual TP: watch price and fire market orders on touch.
      pos.virtualTp = orders.map((o) => ({ price: o.price, qty: o.qty }));
      adapter.watchPrice(pos.symbol);
    }
  }

  private async replaceSlOrder(
    adapter: ExchangeAdapter,
    pos: ManagedPosition,
    info: SymbolInfo,
    afterDca = false,
  ): Promise<void> {
    const sl = pos.config.sl;
    if (pos.slOrderId) {
      await adapter.cancelOrder(pos.symbol, pos.slOrderId).catch(() => {});
      pos.slOrderId = undefined;
    }
    pos.virtualSlPrice = undefined;
    pos.slCandleTf = undefined;
    if (!sl.enabled) return;
    if (afterDca && !sl.reorderAfterDca && pos.slPrice) {
      // keep previous level
    } else {
      pos.slPrice = computeSlPrice(sl, pos.side, pos.entryPrice);
    }
    await this.placeSlAt(adapter, pos, info, pos.slPrice!);
  }

  private async placeSlAt(
    adapter: ExchangeAdapter,
    pos: ManagedPosition,
    info: SymbolInfo,
    price: number,
  ): Promise<void> {
    pos.slPrice = price;
    if (pos.config.sl.trigger === 'candle') {
      // Candle-close SL is server-evaluated: no exchange stop can express
      // "confirmed on close", so it fires a market close from candle events.
      const tf = pos.config.sl.candleTf ?? '1m';
      pos.virtualSlPrice = price;
      pos.slCandleTf = tf;
      adapter.watchCandles(pos.symbol, tf);
      return;
    }
    pos.slCandleTf = undefined;
    if (pos.market === 'futures') {
      const res = await adapter
        .placeOrder({
          symbol: pos.symbol,
          side: pos.side === 'long' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          qty: pos.qty,
          stopPrice: price,
          ...this.closeParams(pos),
        })
        .catch((e) => {
          this.log('error', `SL order failed for ${pos.symbol}: ${e}`);
          return null;
        });
      if (res) pos.slOrderId = res.orderId;
    } else {
      // Spot can't hold TP and SL simultaneously — monitor virtually.
      pos.virtualSlPrice = price;
      adapter.watchPrice(pos.symbol);
    }
  }

  private async cancelProtection(adapter: ExchangeAdapter, pos: ManagedPosition): Promise<void> {
    for (const id of pos.tpOrderIds) await adapter.cancelOrder(pos.symbol, id).catch(() => {});
    if (pos.slOrderId) await adapter.cancelOrder(pos.symbol, pos.slOrderId).catch(() => {});
    // Leftover (unfilled) grid entry orders die with the position.
    for (const id of pos.entryOrderIds ?? []) await adapter.cancelOrder(pos.symbol, id).catch(() => {});
    pos.tpOrderIds = [];
    pos.slOrderId = undefined;
    pos.virtualTp = undefined;
    pos.virtualSlPrice = undefined;
    pos.slCandleTf = undefined;
    pos.entryOrderIds = undefined;
  }

  private async maybeMoveBreakeven(adapter: ExchangeAdapter, pos: ManagedPosition): Promise<void> {
    // Breakeven-after-TP is a stop-loss behaviour: it works regardless of
    // whether the trailing (SLX) module is enabled.
    const after = pos.config.sl.breakevenAfterTp;
    if (after <= 0 || pos.tpFilledCount < after) return;
    const info = await adapter.symbolInfo(pos.symbol);
    if (!info) return;
    // Already at (or better than) breakeven — nothing to do.
    if (pos.slPrice !== undefined) {
      const atBe = pos.side === 'long' ? pos.slPrice >= pos.entryPrice : pos.slPrice <= pos.entryPrice;
      if (atBe) return;
    }
    if (pos.slOrderId) {
      await adapter.cancelOrder(pos.symbol, pos.slOrderId).catch(() => {});
      pos.slOrderId = undefined;
    }
    await this.placeSlAt(adapter, pos, info, pos.entryPrice);
    this.log('info', `SL moved to breakeven for ${pos.symbol} after ${pos.tpFilledCount} TP fill(s)`);
  }

  // ------------------------------------------------------------------
  // Reconciliation: adopt filled positions whose fill event was missed
  // ------------------------------------------------------------------

  /** Poll open positions on a timer and place protection for any intent whose
   *  fill was never observed (dropped user-data event, restart mid-fill). */
  startBackgroundReconcile(intervalMs = 15_000): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => void this.reconcileAll(), intervalMs);
    this.reconcileTimer.unref?.();
  }

  private async reconcileAll(): Promise<void> {
    const seen = new Set<string>();
    for (const intent of [...this.intents.values()]) {
      const k = `${intent.accountId}:${intent.market}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await this.reconcile(intent.accountId, intent.market).catch((e) =>
        this.log('error', `reconcile failed: ${e}`),
      );
    }
  }

  /** One-off reconcile shortly after placing an opening order, to catch a
   *  marketable fill whose user-data event arrives late or never. */
  private scheduleReconcile(accountId: string, market: MarketType, delayMs = 4_000): void {
    const t = setTimeout(() => void this.reconcile(accountId, market).catch(() => {}), delayMs);
    t.unref?.();
  }

  /**
   * Compare exchange positions with pending intents. For any position an intent
   * opened that isn't yet managed by the terminal, adopt it and place TP/SL —
   * this is the safety net when the real-time fill event is missed. Very old
   * intents with no matching position are dropped.
   */
  async reconcile(accountId: string, market: MarketType, knownPositions?: ExchangePosition[]): Promise<void> {
    let adapter: ExchangeAdapter | null = null;
    let positions = knownPositions;
    if (!positions) {
      try {
        adapter = await this.adapter(accountId, market);
        positions = await adapter.getPositions();
      } catch {
        return;
      }
    }

    // Drop managed positions the exchange no longer reports (e.g. closed
    // directly on Binance) so the terminal doesn't keep a stale row with TP/SL
    // it can no longer act on. Runs independently of pending intents.
    await this.pruneClosedPositions(accountId, market, positions);

    const pending = [...this.intents.entries()].filter(([, i]) => i.accountId === accountId && i.market === market);
    if (pending.length === 0) return;
    if (!adapter) {
      try {
        adapter = await this.adapter(accountId, market);
      } catch {
        return;
      }
    }
    const ad = adapter;
    if (!ad) return;
    const hedge = this.isHedge(accountId, market);
    const now = Date.now();
    for (const [key, intent] of pending) {
      const want = intent.dir === 'long' ? 'LONG' : 'SHORT';
      const exPos = positions.find(
        (p) =>
          p.symbol === intent.symbol &&
          Math.abs(p.qty) > 1e-12 &&
          (hedge ? p.positionSide === want : (p.qty > 0) === (intent.dir === 'long')),
      );
      if (!exPos) {
        // Nothing has filled yet; drop only long-stale intents to avoid leaks.
        if (now - intent.createdAt > INTENT_TTL_MS) this.dropIntent(key);
        continue;
      }
      if (this.db.openPositionFor(accountId, market, intent.symbol, hedge ? intent.dir : undefined)) {
        this.dropIntent(key); // a real fill already created the managed position
        continue;
      }
      await this.adoptPosition(ad, key, intent, exPos);
    }
  }

  /**
   * Mark managed positions closed when the exchange no longer reports them —
   * e.g. the user closed the position directly on Binance. Cancels any leftover
   * protective orders and removes the row so it stops showing in the terminal.
   * `positions` must be a trusted live snapshot (a failed fetch never reaches
   * here); a short grace period spares just-opened positions.
   */
  private async pruneClosedPositions(
    accountId: string,
    market: MarketType,
    positions: ExchangePosition[],
  ): Promise<void> {
    const hedge = this.isHedge(accountId, market);
    const now = Date.now();
    const managed = this.db.openPositions(accountId).filter((p) => p.market === market);
    let adapter: ExchangeAdapter | null = null;
    for (const pos of managed) {
      if (now - pos.openedAt < PRUNE_GRACE_MS) continue; // too fresh to trust the snapshot
      const want = pos.side === 'long' ? 'LONG' : 'SHORT';
      const live = positions.find(
        (p) =>
          p.symbol === pos.symbol &&
          Math.abs(p.qty) > 1e-12 &&
          (hedge ? p.positionSide === want : (p.qty > 0) === (pos.side === 'long')),
      );
      if (live) continue; // still open on the exchange
      if (!adapter) adapter = await this.adapter(accountId, market).catch(() => null);
      if (adapter) await this.cancelProtection(adapter, pos).catch(() => {});
      this.dropIntent(this.intentKey(accountId, market, pos.symbol, pos.side));
      this.db.markClosed(pos, pos.realizedPnl);
      this.log('info', `position ${pos.symbol} ${pos.side} closed on the exchange — removed from terminal`);
      this.changed();
    }
  }

  /** Build a managed position from an exchange position and place its
   *  protection, serialized with live fills for that symbol. */
  private async adoptPosition(
    adapter: ExchangeAdapter,
    key: string,
    intent: PendingIntent,
    exPos: ExchangePosition,
  ): Promise<void> {
    const qk = this.key(intent.accountId, intent.market, intent.symbol);
    const prev = this.fillQueues.get(qk) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const hedge = this.isHedge(intent.accountId, intent.market);
        // Re-check under the per-symbol lock: a real fill may have won the race.
        if (!this.intents.has(key)) return;
        if (this.db.openPositionFor(intent.accountId, intent.market, intent.symbol, hedge ? intent.dir : undefined)) {
          this.dropIntent(key);
          return;
        }
        const openOrders = await adapter.getOpenOrders(intent.symbol).catch(() => []);
        const openIds = new Set(openOrders.map((o) => o.orderId));
        const entryOrderIds = (intent.entryOrderIds ?? []).filter((id) => openIds.has(id));
        const pos = this.newManagedPosition({
          accountId: intent.accountId,
          market: intent.market,
          symbol: intent.symbol,
          side: intent.dir,
          qty: Math.abs(exPos.qty),
          entryPrice: exPos.entryPrice,
          leverage: intent.leverage,
          marginMode: intent.marginMode,
          hookId: intent.hookId,
          config: intent.config,
          entryOrderIds: entryOrderIds.length ? entryOrderIds : undefined,
        });
        this.db.upsertPosition(pos);
        this.dropIntent(key);
        this.log(
          'info',
          `reconcile: adopted unmanaged ${pos.side} ${pos.qty} ${pos.symbol} @ ${pos.entryPrice}; placing protection`,
        );
        adapter.watchPrice(pos.symbol);
        await this.applyProtection(adapter, pos);
        this.changed();
      })
      .catch((e) => this.log('error', `reconcile adopt failed: ${e}`));
    this.fillQueues.set(qk, next);
    await next;
  }

  // ------------------------------------------------------------------
  // Price ticks → trailing stop + virtual orders
  // ------------------------------------------------------------------

  private async handlePriceTick(adapter: ExchangeAdapter, symbol: string, price: number): Promise<void> {
    // Hedge mode can hold both a long and a short on the same pair.
    const targets = this.db
      .openPositions(adapter.accountId)
      .filter((p) => p.market === adapter.market && p.symbol === symbol);
    for (const pos of targets) {
      await this.handlePositionTick(adapter, pos, symbol, price);
    }
  }

  private async handlePositionTick(
    adapter: ExchangeAdapter,
    pos: ManagedPosition,
    symbol: string,
    price: number,
  ): Promise<void> {
    const busyKey = `${pos.id}`;
    if (this.trailingBusy.has(busyKey)) return;
    this.trailingBusy.add(busyKey);
    try {
      // Virtual TP levels.
      if (pos.virtualTp?.length) {
        const hit = pos.virtualTp.filter((o) =>
          pos.side === 'long' ? price >= o.price : price <= o.price,
        );
        if (hit.length > 0) {
          pos.virtualTp = pos.virtualTp.filter((o) => !hit.includes(o));
          this.db.upsertPosition(pos);
          for (const o of hit) {
            await adapter
              .placeOrder({
                symbol,
                side: pos.side === 'long' ? 'SELL' : 'BUY',
                type: 'MARKET',
                qty: Math.min(o.qty, pos.qty),
                ...this.closeParams(pos),
              })
              .catch((e) => this.log('error', `virtual TP failed: ${e}`));
            pos.tpFilledCount += 1;
          }
          await this.maybeMoveBreakeven(adapter, pos);
        }
      }

      // Virtual SL on touch (spot). Candle-triggered SLs wait for closes.
      if (pos.virtualSlPrice && !pos.slCandleTf && pos.qty > 0) {
        const hit = pos.side === 'long' ? price <= pos.virtualSlPrice : price >= pos.virtualSlPrice;
        if (hit) {
          pos.virtualSlPrice = undefined;
          this.db.upsertPosition(pos);
          await this.closePositionMarket(adapter, pos, 1).catch((e) => this.log('error', `virtual SL failed: ${e}`));
          return;
        }
      }

      // Trailing stop on ticks (candle-triggered trailing advances on closes).
      if (pos.config.slx.trigger !== 'candle') {
        await this.advanceTrailing(adapter, pos, symbol, price);
      }
    } finally {
      this.trailingBusy.delete(busyKey);
    }
  }

  private async advanceTrailing(
    adapter: ExchangeAdapter,
    pos: ManagedPosition,
    symbol: string,
    price: number,
  ): Promise<void> {
    const slx = pos.config.slx;
    if (!slx.enabled || pos.qty <= 0) return;
    const update = updateTrailing(slx, pos.side, pos.entryPrice, pos.trailing, price);
    const changed =
      update.armed !== (pos.trailing?.armed ?? false) || update.stopPrice !== (pos.trailing?.stopPrice ?? 0);
    pos.trailing = { armed: update.armed, bestPrice: update.bestPrice, stopPrice: update.stopPrice };
    if (changed) this.db.upsertPosition(pos);
    if (update.armed && update.triggered) {
      pos.config.slx = { ...slx, enabled: false };
      this.db.upsertPosition(pos);
      this.log('info', `trailing stop triggered for ${symbol} @ ${price}`);
      await this.closePositionMarket(adapter, pos, 1).catch((e) => this.log('error', `trailing close failed: ${e}`));
    }
  }

  /** Candle-close events drive candle-triggered SLs and trailing stops. */
  private async handleCandleClose(
    adapter: ExchangeAdapter,
    symbol: string,
    interval: string,
    close: number,
  ): Promise<void> {
    const targets = this.db
      .openPositions(adapter.accountId)
      .filter((p) => p.market === adapter.market && p.symbol === symbol);
    for (const pos of targets) {
      if (pos.qty <= 0) continue;
      // Candle-close SL: fires only when the trigger candle CLOSES beyond
      // the level (long: at or below; short: at or above) — wicks don't.
      if (pos.virtualSlPrice && pos.slCandleTf === interval) {
        const hit = pos.side === 'long' ? close <= pos.virtualSlPrice : close >= pos.virtualSlPrice;
        if (hit) {
          pos.virtualSlPrice = undefined;
          pos.slCandleTf = undefined;
          this.db.upsertPosition(pos);
          this.log('info', `candle-close SL triggered for ${symbol} (${interval} close ${close})`);
          await this.closePositionMarket(adapter, pos, 1).catch((e) => this.log('error', `candle SL failed: ${e}`));
          continue;
        }
      }
      const slx = pos.config.slx;
      if (slx.enabled && slx.trigger === 'candle' && (slx.candleTf ?? '1m') === interval) {
        await this.advanceTrailing(adapter, pos, symbol, close);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    await this.settle().catch(() => {});
    for (const a of this.adapters.values()) await a.close().catch(() => {});
    this.db.flush();
  }
}
