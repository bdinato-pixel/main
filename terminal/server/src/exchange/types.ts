import type { MarketType } from '../store/types.js';

export interface SymbolInfo {
  symbol: string;
  base: string;
  quote: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface ExchangePosition {
  symbol: string;
  /** Signed base quantity: > 0 long, < 0 short. */
  qty: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  /** Hedge mode: which side of the dual position this row is. */
  positionSide?: 'LONG' | 'SHORT';
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP' | 'TAKE_PROFIT_MARKET';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  /** Hedge mode: which side of the dual position this order acts on. */
  positionSide?: 'LONG' | 'SHORT';
  clientId?: string;
}

export interface OrderResult {
  orderId: string;
  status: 'NEW' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  executedQty: number;
  avgPrice: number;
}

export interface OpenOrder {
  orderId: string;
  symbol: string;
  side: OrderSide;
  type: string;
  price: number;
  stopPrice: number;
  origQty: number;
  executedQty: number;
  reduceOnly: boolean;
  clientId?: string;
  time: number;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  changePct: number;
  quoteVolume: number;
}

export interface FillEvent {
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  orderId: string;
  reduceOnly: boolean;
  positionSide?: 'LONG' | 'SHORT';
  time: number;
}

/**
 * A market-scoped exchange connection (one instance per spot/futures market
 * per account).
 */
export interface ExchangeAdapter {
  readonly market: MarketType;
  readonly accountId: string;

  getSymbols(): Promise<SymbolInfo[]>;
  symbolInfo(symbol: string): Promise<SymbolInfo | undefined>;
  getBalances(): Promise<Balance[]>;
  /** Futures only; spot adapters return []. */
  getPositions(): Promise<ExchangePosition[]>;
  getOpenOrders(symbol?: string): Promise<OpenOrder[]>;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  setMarginMode(symbol: string, mode: 'cross' | 'isolated'): Promise<void>;
  /** Futures dual-side (hedge) position mode; no-op on spot. */
  setPositionMode(dual: boolean): Promise<void>;
  getPrice(symbol: string): Promise<number>;
  getTickers(): Promise<Ticker[]>;
  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;

  /** Order fills (from the user-data stream or the paper simulator). */
  onFill(cb: (fill: FillEvent) => void): void;
  /** Live price ticks for symbols the engine watches. */
  watchPrice(symbol: string): void;
  onPrice(cb: (symbol: string, price: number) => void): void;
  /** Closed candles of a timeframe (for candle-close SL/trailing triggers). */
  watchCandles(symbol: string, interval: string): void;
  onCandleClose(cb: (symbol: string, interval: string, candle: Kline) => void): void;

  close(): Promise<void>;
}
