import type { MarketType } from '../../store/types.js';
import type { FillEvent, Kline } from '../types.js';
import type { BinanceRest } from './rest.js';
import { BINANCE_WS } from './rest.js';

/**
 * Binance websocket streams: mark/last-price ticks for watched symbols and
 * the account user-data stream (order fills). Uses the global WebSocket
 * client available in Node >= 20.
 */
export class BinanceStreams {
  private priceWs: WebSocket | null = null;
  private userWs: WebSocket | null = null;
  private watched = new Set<string>();
  private watchedKlines = new Set<string>(); // "btcusdt@kline_1m" stream names
  private prices = new Map<string, number>();
  private priceCbs: ((symbol: string, price: number) => void)[] = [];
  private candleCbs: ((symbol: string, interval: string, candle: Kline) => void)[] = [];
  private fillCbs: ((fill: FillEvent) => void)[] = [];
  private keepAlive: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly market: MarketType,
    private readonly rest: BinanceRest,
    private readonly wsBase = BINANCE_WS[market],
  ) {}

  lastPrice(symbol: string): number | undefined {
    return this.prices.get(symbol);
  }

  watchPrice(symbol: string): void {
    if (this.watched.has(symbol)) return;
    this.watched.add(symbol);
    this.reconnectPriceWs();
  }

  onPrice(cb: (symbol: string, price: number) => void): void {
    this.priceCbs.push(cb);
  }

  watchCandles(symbol: string, interval: string): void {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    if (this.watchedKlines.has(stream)) return;
    this.watchedKlines.add(stream);
    this.reconnectPriceWs();
  }

  onCandleClose(cb: (symbol: string, interval: string, candle: Kline) => void): void {
    this.candleCbs.push(cb);
  }

  onFill(cb: (fill: FillEvent) => void): void {
    this.fillCbs.push(cb);
  }

  private reconnectPriceWs(): void {
    this.priceWs?.close();
    if ((this.watched.size === 0 && this.watchedKlines.size === 0) || this.closed) return;
    const streams = [
      ...[...this.watched].map((s) => `${s.toLowerCase()}@miniTicker`),
      ...this.watchedKlines,
    ].join('/');
    const ws = new WebSocket(`${this.wsBase}/stream?streams=${streams}`);
    this.priceWs = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          data?: {
            e?: string;
            s?: string;
            c?: string;
            k?: { t: number; T: number; s: string; i: string; o: string; h: string; l: string; c: string; v: string; x: boolean };
          };
        };
        const data = msg.data;
        if (!data) return;
        if (data.e === 'kline' && data.k) {
          const k = data.k;
          const close = Number(k.c);
          if (close > 0) {
            this.prices.set(k.s, close);
            if (k.x) {
              const candle: Kline = {
                openTime: k.t,
                open: Number(k.o),
                high: Number(k.h),
                low: Number(k.l),
                close,
                volume: Number(k.v),
                closeTime: k.T,
              };
              this.candleCbs.forEach((cb) => cb(k.s, k.i, candle));
            }
          }
          return;
        }
        const s = data.s;
        const c = Number(data.c);
        if (s && c > 0) {
          this.prices.set(s, c);
          this.priceCbs.forEach((cb) => cb(s, c));
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (!this.closed && this.priceWs === ws) {
        setTimeout(() => this.reconnectPriceWs(), 2_000);
      }
    };
    ws.onerror = () => ws.close();
  }

  async startUserStream(): Promise<void> {
    const listenKey = await this.rest.createListenKey();
    const url = `${BINANCE_WS[this.market]}/ws/${listenKey}`;
    const ws = new WebSocket(url);
    this.userWs = ws;
    ws.onmessage = (ev) => this.handleUserEvent(String(ev.data));
    ws.onclose = () => {
      if (!this.closed) setTimeout(() => void this.startUserStream().catch(() => {}), 5_000);
    };
    ws.onerror = () => ws.close();
    this.keepAlive?.unref?.();
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => void this.rest.keepAliveListenKey(listenKey).catch(() => {}), 30 * 60_000);
    this.keepAlive.unref?.();
  }

  private handleUserEvent(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    // Futures: ORDER_TRADE_UPDATE { o: {...} }; spot: executionReport (flat).
    if (msg.e === 'ORDER_TRADE_UPDATE') {
      const o = msg.o as Record<string, unknown>;
      if (o.X === 'FILLED' || o.X === 'PARTIALLY_FILLED') {
        this.emitFill({
          symbol: String(o.s),
          side: o.S === 'BUY' ? 'BUY' : 'SELL',
          qty: Number(o.l), // last filled qty
          price: Number(o.L), // last filled price
          orderId: String(o.i),
          reduceOnly: Boolean(o.R),
          positionSide: o.ps === 'LONG' || o.ps === 'SHORT' ? (o.ps as 'LONG' | 'SHORT') : undefined,
          time: Number(msg.E),
        });
      }
    } else if (msg.e === 'executionReport') {
      if (msg.X === 'FILLED' || msg.X === 'PARTIALLY_FILLED') {
        this.emitFill({
          symbol: String(msg.s),
          side: msg.S === 'BUY' ? 'BUY' : 'SELL',
          qty: Number(msg.l),
          price: Number(msg.L),
          orderId: String(msg.i),
          reduceOnly: false,
          time: Number(msg.E),
        });
      }
    }
  }

  private emitFill(fill: FillEvent): void {
    if (fill.qty <= 0) return;
    this.fillCbs.forEach((cb) => cb(fill));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.priceWs?.close();
    this.userWs?.close();
  }
}
