import { randomUUID } from 'node:crypto';
import type { MarketType } from '../store/types.js';
import type {
  Balance,
  ExchangeAdapter,
  ExchangePosition,
  FillEvent,
  Kline,
  OpenOrder,
  OrderRequest,
  OrderResult,
  SymbolInfo,
  Ticker,
} from './types.js';
import { quantizeQty, quantizePrice } from '../engine/quantizer.js';

/** Where the paper adapter gets market data. */
export interface PriceSource {
  getSymbols(): Promise<SymbolInfo[]>;
  getPrice(symbol: string): Promise<number>;
  getTickers(): Promise<Ticker[]>;
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  watchPrice(symbol: string): void;
  onPrice(cb: (symbol: string, price: number) => void): void;
  watchCandles(symbol: string, interval: string): void;
  onCandleClose(cb: (symbol: string, interval: string, candle: Kline) => void): void;
  close(): Promise<void>;
}

/** Fully scripted price source for tests and offline use. */
export class ManualPriceSource implements PriceSource {
  private prices = new Map<string, number>();
  private cbs: ((symbol: string, price: number) => void)[] = [];
  private candleCbs: ((symbol: string, interval: string, candle: Kline) => void)[] = [];

  constructor(private symbols: SymbolInfo[]) {}

  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
    this.cbs.forEach((cb) => cb(symbol, price));
  }

  /** Emit a closed candle (all OHLC = close unless given). */
  closeCandle(symbol: string, interval: string, close: number, partial: Partial<Kline> = {}): void {
    this.prices.set(symbol, close);
    const now = Date.now();
    const candle: Kline = {
      openTime: now - 60_000,
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
      closeTime: now,
      ...partial,
    };
    this.candleCbs.forEach((cb) => cb(symbol, interval, candle));
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    return this.symbols;
  }

  async getPrice(symbol: string): Promise<number> {
    const p = this.prices.get(symbol);
    if (p === undefined) throw new Error(`No price set for ${symbol}`);
    return p;
  }

  async getTickers(): Promise<Ticker[]> {
    return [...this.prices.entries()].map(([symbol, last]) => ({ symbol, last, changePct: 0, quoteVolume: 0 }));
  }

  async getKlines(): Promise<Kline[]> {
    return [];
  }

  watchPrice(): void {}

  onPrice(cb: (symbol: string, price: number) => void): void {
    this.cbs.push(cb);
  }

  watchCandles(): void {}

  onCandleClose(cb: (symbol: string, interval: string, candle: Kline) => void): void {
    this.candleCbs.push(cb);
  }

  async close(): Promise<void> {}
}

interface PaperPosition {
  symbol: string;
  qty: number; // signed
  entryPrice: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  positionSide?: 'LONG' | 'SHORT';
}

interface PaperOrder extends OpenOrder {
  positionSide?: 'LONG' | 'SHORT';
  triggered?: boolean;
}

/**
 * Simulated exchange: instant market fills at the source price, limit and
 * stop orders triggered on price ticks. One quote balance (USDT) with
 * futures-style signed positions; spot mode swaps base/quote balances.
 */
export class PaperAdapter implements ExchangeAdapter {
  private quote = 'USDT';
  private balances = new Map<string, number>();
  private positions = new Map<string, PaperPosition>();
  private orders: PaperOrder[] = [];
  private leverage = new Map<string, number>();
  private marginModes = new Map<string, 'cross' | 'isolated'>();
  private fillCbs: ((fill: FillEvent) => void)[] = [];
  private symbolsCache = new Map<string, SymbolInfo>();
  private hedge = false;

  constructor(
    readonly market: MarketType,
    readonly accountId: string,
    private readonly source: PriceSource,
    startBalanceUsd = 10_000,
  ) {
    this.balances.set(this.quote, startBalanceUsd);
    this.source.onPrice((symbol, price) => this.checkTriggers(symbol, price));
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    const list = await this.source.getSymbols();
    for (const s of list) this.symbolsCache.set(s.symbol, s);
    return list;
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo | undefined> {
    return (await this.getSymbols()).find((s) => s.symbol === symbol);
  }

  async getBalances(): Promise<Balance[]> {
    return [...this.balances.entries()]
      .filter(([, v]) => Math.abs(v) > 1e-12)
      .map(([asset, free]) => ({ asset, free, locked: 0 }));
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const out: ExchangePosition[] = [];
    for (const p of this.positions.values()) {
      if (p.qty === 0) continue;
      const mark = await this.source.getPrice(p.symbol).catch(() => p.entryPrice);
      out.push({
        symbol: p.symbol,
        qty: p.qty,
        entryPrice: p.entryPrice,
        markPrice: mark,
        unrealizedPnl: (mark - p.entryPrice) * p.qty,
        leverage: p.leverage,
        marginMode: p.marginMode,
        positionSide: p.positionSide,
      });
    }
    return out;
  }

  async setPositionMode(dual: boolean): Promise<void> {
    this.hedge = dual && this.market === 'futures';
  }

  /** Positions are keyed per side in hedge mode, per symbol in one-way. */
  private posKey(symbol: string, positionSide?: 'LONG' | 'SHORT'): string {
    return this.hedge ? `${symbol}:${positionSide ?? 'LONG'}` : symbol;
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    return this.orders.filter((o) => !symbol || o.symbol === symbol);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const info = await this.symbolInfo(req.symbol);
    if (!info) throw new Error(`Unknown symbol ${req.symbol}`);
    const qty = quantizeQty(info, req.qty);
    if (qty <= 0) throw new Error(`Quantity ${req.qty} quantizes to 0 for ${req.symbol}`);
    const orderId = randomUUID().slice(0, 13);

    if (req.type === 'MARKET') {
      const price = await this.source.getPrice(req.symbol);
      this.fill(req, qty, price, orderId);
      return { orderId, status: 'FILLED', executedQty: qty, avgPrice: price };
    }

    const order: PaperOrder = {
      orderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      price: quantizePrice(info, req.price ?? 0),
      stopPrice: quantizePrice(info, req.stopPrice ?? 0),
      origQty: qty,
      executedQty: 0,
      reduceOnly: req.reduceOnly ?? false,
      positionSide: req.positionSide,
      clientId: req.clientId,
      time: Date.now(),
    };
    this.orders.push(order);
    this.source.watchPrice(req.symbol);
    // A resting order may already be marketable.
    const price = await this.source.getPrice(req.symbol).catch(() => 0);
    if (price > 0) this.checkTriggers(req.symbol, price);
    const placed = this.orders.find((o) => o.orderId === orderId);
    if (!placed) {
      return { orderId, status: 'FILLED', executedQty: qty, avgPrice: price };
    }
    return { orderId, status: 'NEW', executedQty: 0, avgPrice: 0 };
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<void> {
    this.orders = this.orders.filter((o) => o.orderId !== orderId);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.leverage.set(symbol, leverage);
    for (const pos of this.positions.values()) {
      if (pos.symbol === symbol) pos.leverage = leverage;
    }
  }

  async setMarginMode(symbol: string, mode: 'cross' | 'isolated'): Promise<void> {
    this.marginModes.set(symbol, mode);
  }

  async getPrice(symbol: string): Promise<number> {
    return this.source.getPrice(symbol);
  }

  async getTickers(): Promise<Ticker[]> {
    return this.source.getTickers();
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    return this.source.getKlines(symbol, interval, limit);
  }

  onFill(cb: (fill: FillEvent) => void): void {
    this.fillCbs.push(cb);
  }

  watchPrice(symbol: string): void {
    this.source.watchPrice(symbol);
  }

  onPrice(cb: (symbol: string, price: number) => void): void {
    this.source.onPrice(cb);
  }

  watchCandles(symbol: string, interval: string): void {
    this.source.watchCandles(symbol, interval);
  }

  onCandleClose(cb: (symbol: string, interval: string, candle: Kline) => void): void {
    this.source.onCandleClose(cb);
  }

  async close(): Promise<void> {
    await this.source.close();
  }

  private checkTriggers(symbol: string, price: number): void {
    const pending = this.orders.filter((o) => o.symbol === symbol);
    for (const o of pending) {
      let fillAt: number | null = null;
      if (o.type === 'LIMIT') {
        if (o.side === 'BUY' && price <= o.price) fillAt = o.price;
        if (o.side === 'SELL' && price >= o.price) fillAt = o.price;
      } else if (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET') {
        // Stop triggers when price crosses stopPrice against the resting side.
        if (o.side === 'BUY' && price >= o.stopPrice) fillAt = price;
        if (o.side === 'SELL' && price <= o.stopPrice) fillAt = price;
      } else if (o.type === 'STOP') {
        if (o.side === 'BUY' && price >= o.stopPrice) fillAt = Math.max(o.price, price);
        if (o.side === 'SELL' && price <= o.stopPrice) fillAt = Math.min(o.price, price);
      }
      if (fillAt !== null) {
        this.orders = this.orders.filter((x) => x.orderId !== o.orderId);
        this.fill(
          {
            symbol: o.symbol,
            side: o.side,
            type: 'MARKET',
            qty: o.origQty,
            reduceOnly: o.reduceOnly,
            positionSide: o.positionSide,
          },
          o.origQty,
          fillAt,
          o.orderId,
        );
      }
    }
  }

  private fill(req: OrderRequest, qty: number, price: number, orderId: string): void {
    const signed = req.side === 'BUY' ? qty : -qty;
    const ps = this.hedge && this.market === 'futures'
      ? req.positionSide ?? (req.side === 'BUY' ? 'LONG' : 'SHORT')
      : undefined;
    if (this.market === 'futures') {
      const key = this.posKey(req.symbol, ps);
      const pos = this.positions.get(key) ?? {
        symbol: req.symbol,
        qty: 0,
        entryPrice: 0,
        leverage: this.leverage.get(req.symbol) ?? 5,
        marginMode: this.marginModes.get(req.symbol) ?? 'cross',
        positionSide: ps,
      };
      let fillQty = signed;
      // In hedge mode an order against its positionSide can only reduce it
      // (Binance never flips a dual-side position), same as reduce-only.
      const clampReduce = req.reduceOnly || (ps === 'LONG' && signed < 0) || (ps === 'SHORT' && signed > 0);
      if (clampReduce) {
        // Clamp reducing fills so they only shrink |position| toward zero.
        if (pos.qty > 0) fillQty = Math.max(-pos.qty, Math.min(0, signed));
        else if (pos.qty < 0) fillQty = Math.min(-pos.qty, Math.max(0, signed));
        else fillQty = 0;
        if (fillQty === 0) return;
        qty = Math.abs(fillQty);
      }
      const closingQty =
        Math.sign(pos.qty) !== Math.sign(fillQty) ? Math.min(Math.abs(pos.qty), Math.abs(fillQty)) : 0;
      if (closingQty > 0) {
        const pnl = (price - pos.entryPrice) * closingQty * Math.sign(pos.qty);
        this.balances.set(this.quote, (this.balances.get(this.quote) ?? 0) + pnl);
      }
      const newQty = pos.qty + fillQty;
      if (Math.sign(newQty) !== Math.sign(pos.qty) && pos.qty !== 0 && newQty !== 0) {
        // Flipped through zero: remainder opens at the fill price.
        pos.entryPrice = price;
      } else if (Math.sign(pos.qty) === Math.sign(fillQty) || pos.qty === 0) {
        const total = Math.abs(pos.qty) + Math.abs(fillQty);
        pos.entryPrice = total > 0 ? (pos.entryPrice * Math.abs(pos.qty) + price * Math.abs(fillQty)) / total : 0;
      }
      pos.qty = Number(newQty.toFixed(10));
      if (pos.qty === 0) this.positions.delete(key);
      else this.positions.set(key, pos);
    } else {
      // Spot: swap base and quote balances.
      const info = this.symbolsCache.get(req.symbol);
      const base = info?.base ?? req.symbol.replace(/(USDT|USDC|BUSD|BTC|ETH|BNB)$/u, '');
      const quote = info?.quote ?? (req.symbol.slice(base.length) || this.quote);
      const baseBal = this.balances.get(base) ?? 0;
      const quoteBal = this.balances.get(quote) ?? 0;
      if (req.side === 'BUY') {
        this.balances.set(base, baseBal + qty);
        this.balances.set(quote, quoteBal - qty * price);
      } else {
        this.balances.set(base, baseBal - qty);
        this.balances.set(quote, quoteBal + qty * price);
      }
    }
    this.fillCbs.forEach((cb) =>
      cb({
        symbol: req.symbol,
        side: req.side,
        qty: Math.abs(qty),
        price,
        orderId,
        reduceOnly: req.reduceOnly ?? false,
        positionSide: ps,
        time: Date.now(),
      }),
    );
  }
}
