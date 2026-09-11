import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Db } from '../store/db.js';
import type {
  Hook,
  ManagedPosition,
  MarketType,
  PositionDir,
  Signal,
  SignalLogEntry,
} from '../store/types.js';
import type { ExchangeAdapter, FillEvent, SymbolInfo } from '../exchange/types.js';
import { computeBaseQty, type AmountCtx } from './amount.js';
import { decide } from './decide.js';
import { planTpOrders, slPrice as computeSlPrice, updateTrailing } from './modules.js';
import { quantizeOrder, quantizeQty } from './quantizer.js';
import { effectiveHook, parseSignal, SignalError, signalTpOrders } from './signal.js';
import { defaultSlModule, defaultSlxModule, defaultTpModule } from './defaults.js';

export type AdapterFactory = (accountId: string, market: MarketType) => Promise<ExchangeAdapter>;

interface PendingIntent {
  dir: PositionDir;
  hookId?: string;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  config: ManagedPosition['config'];
  createdAt: number;
}

export interface ManualOrderInput {
  accountId: string;
  market: MarketType;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop_market';
  qty: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  leverage?: number;
  marginMode?: 'cross' | 'isolated';
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

  constructor(
    readonly db: Db,
    private readonly adapterFactory: AdapterFactory,
  ) {
    super();
  }

  private key(accountId: string, market: MarketType, symbol?: string): string {
    return symbol ? `${accountId}:${market}:${symbol}` : `${accountId}:${market}`;
  }

  async adapter(accountId: string, market: MarketType): Promise<ExchangeAdapter> {
    const k = this.key(accountId, market);
    let a = this.adapters.get(k);
    if (!a) {
      a = await this.adapterFactory(accountId, market);
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
      // Watch prices for existing open positions after a restart.
      for (const p of this.db.openPositions(accountId)) {
        if (p.market === market) a.watchPrice(p.symbol);
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

    const position = this.db.openPositionFor(hook.accountId, hook.market, symbol);
    const decision = decide(h, { ...signal, symbol }, position);

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
    const free = quoteBal?.free ?? 0;
    let positionsVolume = 0;
    let pnl = 0;
    for (const p of await adapter.getPositions()) {
      positionsVolume += Math.abs(p.qty) * p.entryPrice;
      pnl += p.unrealizedPnl;
    }
    const wallet = balances.reduce((s, b) => s + (b.asset === info.quote ? b.free + b.locked : 0), 0);
    return {
      price: refPrice,
      leverage,
      freeBalance: free,
      fullBalance: wallet + positionsVolume + pnl,
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

    this.intents.set(key, {
      dir,
      hookId: h.id,
      leverage: o.leverage,
      marginMode: o.marginMode,
      config: this.snapshotConfig(h),
      createdAt: Date.now(),
    });
    adapter.watchPrice(info.symbol);

    const params = this.entryOrderParams(o.orderType, dir, price, o.priceOffsetPct);
    try {
      const res = await adapter.placeOrder({
        symbol: info.symbol,
        side: dir === 'long' ? 'BUY' : 'SELL',
        qty: q.qty,
        ...params,
      });
      return `open ${dir} ${q.qty} ${info.symbol} @ ${params.type} (order ${res.orderId}, ${res.status})`;
    } catch (e) {
      this.intents.delete(key);
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

    const params = this.entryOrderParams(d.orderType, position.side, price, d.priceOffsetPct);
    const res = await adapter.placeOrder({
      symbol: info.symbol,
      side: position.side === 'long' ? 'BUY' : 'SELL',
      qty: q.qty,
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
    if (reverse) {
      // Reverse: close the position and open the opposite side using the
      // open module's amount in one order.
      const price = await this.refPrice(adapter, info.symbol, signal);
      const ctx = await this.amountCtx(adapter, info, h.open.leverage, price);
      extraQty = computeBaseQty(h.open.amount, ctx);
      closeQty = position.qty;
      const newDir: PositionDir = position.side === 'long' ? 'short' : 'long';
      this.intents.set(this.key(h.accountId, h.market, info.symbol), {
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
        reduceOnly: !reverse && h.market === 'futures',
      });
      return `${reverse ? 'reverse' : 'close'} ${side} ${total} ${info.symbol} (order ${res.orderId}, ${res.status})`;
    } catch (e) {
      if (reverse) this.intents.delete(this.key(h.accountId, h.market, info.symbol));
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
    const q = quantizeOrder(info, input.qty, price);
    if (!q) throw new Error(`Quantity ${input.qty} is below the exchange minimum`);

    const dir: PositionDir = input.side === 'buy' ? 'long' : 'short';
    if (input.market === 'futures') {
      if (input.leverage) await adapter.setLeverage(input.symbol, input.leverage).catch(() => {});
      if (input.marginMode) await adapter.setMarginMode(input.symbol, input.marginMode).catch(() => {});
    }
    // Spot sells reduce holdings — never an opening intent for a "short".
    const opensPosition = !input.reduceOnly && !(input.market === 'spot' && input.side === 'sell');
    if (opensPosition) {
      this.intents.set(this.key(input.accountId, input.market, input.symbol), {
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
      });
      adapter.watchPrice(input.symbol);
    }

    try {
      const res = await adapter.placeOrder({
        symbol: input.symbol,
        side: input.side === 'buy' ? 'BUY' : 'SELL',
        type: input.type === 'market' ? 'MARKET' : input.type === 'limit' ? 'LIMIT' : 'STOP_MARKET',
        qty: q.qty,
        price: input.type === 'limit' ? q.price : undefined,
        stopPrice: input.type === 'stop_market' ? input.stopPrice ?? q.price : undefined,
        reduceOnly: input.reduceOnly && input.market === 'futures',
      });
      this.changed();
      return res.orderId;
    } catch (e) {
      if (opensPosition) this.intents.delete(this.key(input.accountId, input.market, input.symbol));
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
      reduceOnly: pos.market === 'futures',
    });
  }

  // ------------------------------------------------------------------
  // Fill handling → position lifecycle
  // ------------------------------------------------------------------

  private async handleFill(adapter: ExchangeAdapter, fill: FillEvent): Promise<void> {
    const { accountId, market } = adapter;
    const key = this.key(accountId, market, fill.symbol);
    let pos = this.db.openPositionFor(accountId, market, fill.symbol);
    const fillDir: PositionDir = fill.side === 'BUY' ? 'long' : 'short';

    if (!pos) {
      const intent = this.intents.get(key);
      if (!intent || intent.dir !== fillDir) return; // external or stale fill
      pos = this.createPosition(accountId, market, fill, intent);
      this.intents.delete(key);
      this.log('info', `position opened: ${pos.side} ${pos.qty} ${pos.symbol} @ ${pos.entryPrice}`);
      await this.applyProtection(adapter, pos);
      this.changed();
      return;
    }

    if (fillDir === pos.side) {
      // Averaging fill: grow position, recompute average, reorder TP/SL.
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
      // Remainder of a reversal fill opens the opposite position.
      const rest = fill.qty - reduce;
      const intent = this.intents.get(key);
      if (rest > 0 && intent && intent.dir === fillDir) {
        const newPos = this.createPosition(accountId, market, { ...fill, qty: rest }, intent);
        this.intents.delete(key);
        this.log('info', `position reversed: now ${newPos.side} ${newPos.qty} ${newPos.symbol}`);
        await this.applyProtection(adapter, newPos);
        this.changed();
      }
    }
  }

  private createPosition(
    accountId: string,
    market: MarketType,
    fill: FillEvent,
    intent: PendingIntent,
  ): ManagedPosition {
    const pos: ManagedPosition = {
      id: randomUUID(),
      accountId,
      market,
      symbol: fill.symbol,
      side: intent.dir,
      qty: fill.qty,
      entryPrice: fill.price,
      leverage: intent.leverage,
      marginMode: intent.marginMode,
      hookId: intent.hookId,
      openedAt: Date.now(),
      status: 'open',
      realizedPnl: 0,
      dcaCount: 0,
      tpOrderIds: [],
      tpFilledCount: 0,
      config: intent.config,
    };
    this.db.upsertPosition(pos);
    return pos;
  }

  /** Place/replace TP grid and SL for a position. */
  private async applyProtection(adapter: ExchangeAdapter, pos: ManagedPosition, afterDca = false): Promise<void> {
    const info = await adapter.symbolInfo(pos.symbol);
    if (!info) return;
    await this.replaceTpOrders(adapter, pos, info, afterDca);
    await this.replaceSlOrder(adapter, pos, info, afterDca);
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
            reduceOnly: pos.market === 'futures',
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
    if (pos.market === 'futures') {
      const res = await adapter
        .placeOrder({
          symbol: pos.symbol,
          side: pos.side === 'long' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          qty: pos.qty,
          stopPrice: price,
          reduceOnly: true,
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
    pos.tpOrderIds = [];
    pos.slOrderId = undefined;
    pos.virtualTp = undefined;
    pos.virtualSlPrice = undefined;
  }

  private async maybeMoveBreakeven(adapter: ExchangeAdapter, pos: ManagedPosition): Promise<void> {
    const slx = pos.config.slx;
    if (!slx.enabled || slx.breakevenAfterTp <= 0) return;
    if (pos.tpFilledCount < slx.breakevenAfterTp) return;
    const info = await adapter.symbolInfo(pos.symbol);
    if (!info) return;
    if (pos.slOrderId) {
      await adapter.cancelOrder(pos.symbol, pos.slOrderId).catch(() => {});
      pos.slOrderId = undefined;
    }
    await this.placeSlAt(adapter, pos, info, pos.entryPrice);
    this.log('info', `SL moved to breakeven for ${pos.symbol}`);
  }

  // ------------------------------------------------------------------
  // Price ticks → trailing stop + virtual orders
  // ------------------------------------------------------------------

  private async handlePriceTick(adapter: ExchangeAdapter, symbol: string, price: number): Promise<void> {
    const pos = this.db.openPositionFor(adapter.accountId, adapter.market, symbol);
    if (!pos) return;
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
                reduceOnly: pos.market === 'futures',
              })
              .catch((e) => this.log('error', `virtual TP failed: ${e}`));
            pos.tpFilledCount += 1;
          }
          await this.maybeMoveBreakeven(adapter, pos);
        }
      }

      // Virtual SL (spot).
      if (pos.virtualSlPrice && pos.qty > 0) {
        const hit = pos.side === 'long' ? price <= pos.virtualSlPrice : price >= pos.virtualSlPrice;
        if (hit) {
          pos.virtualSlPrice = undefined;
          this.db.upsertPosition(pos);
          await this.closePositionMarket(adapter, pos, 1).catch((e) => this.log('error', `virtual SL failed: ${e}`));
          return;
        }
      }

      // Trailing stop.
      const slx = pos.config.slx;
      if (slx.enabled && pos.qty > 0) {
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
    } finally {
      this.trailingBusy.delete(busyKey);
    }
  }

  async shutdown(): Promise<void> {
    await this.settle().catch(() => {});
    for (const a of this.adapters.values()) await a.close().catch(() => {});
    this.db.flush();
  }
}
