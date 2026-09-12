import type { MarketType } from '../store/types.js';
import type { Kline, SymbolInfo, Ticker } from './types.js';
import type { PriceSource } from './paper.js';
import { BinanceAdapter } from './binance/adapter.js';
import { BINANCE_VISION } from './binance/rest.js';

/**
 * Keyless market-data source backed by Binance public endpoints — feeds the
 * paper adapter with real prices without any API key. Spot data uses the
 * binance.vision mirror, which also works from geo-restricted networks.
 */
export class BinancePublicSource implements PriceSource {
  private adapter: BinanceAdapter;

  constructor(market: MarketType) {
    const overrides = market === 'spot' ? { base: BINANCE_VISION.base, ws: BINANCE_VISION.ws } : undefined;
    this.adapter = new BinanceAdapter(market, 'public', { apiKey: '', apiSecret: '' }, overrides);
  }

  getSymbols(): Promise<SymbolInfo[]> {
    return this.adapter.getSymbols();
  }

  getPrice(symbol: string): Promise<number> {
    return this.adapter.getPrice(symbol);
  }

  getTickers(): Promise<Ticker[]> {
    return this.adapter.getTickers();
  }

  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    return this.adapter.getKlines(symbol, interval, limit);
  }

  watchPrice(symbol: string): void {
    this.adapter.watchPrice(symbol);
  }

  onPrice(cb: (symbol: string, price: number) => void): void {
    this.adapter.onPrice(cb);
  }

  watchCandles(symbol: string, interval: string): void {
    this.adapter.watchCandles(symbol, interval);
  }

  onCandleClose(cb: (symbol: string, interval: string, candle: Kline) => void): void {
    this.adapter.onCandleClose(cb);
  }

  close(): Promise<void> {
    return this.adapter.close();
  }
}
