import type { MarketType } from '../../store/types.js';
import type {
  AccountEquity,
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
} from '../types.js';
import { BinanceRest, type BinanceCredentials } from './rest.js';
import { BinanceStreams } from './streams.js';
import { formatQty, formatPrice } from '../../engine/quantizer.js';

interface RawFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
  notional?: string;
}

interface RawSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  contractType?: string;
  filters: RawFilter[];
}

export class BinanceAdapter implements ExchangeAdapter {
  private rest: BinanceRest;
  private streams: BinanceStreams;
  private symbols = new Map<string, SymbolInfo>();
  private symbolsLoadedAt = 0;
  private fillCbs: ((fill: FillEvent) => void)[] = [];

  constructor(
    readonly market: MarketType,
    readonly accountId: string,
    creds: BinanceCredentials,
    overrides?: { base?: string; ws?: string },
  ) {
    this.rest = new BinanceRest(market, creds, overrides?.base);
    this.streams = new BinanceStreams(market, this.rest, overrides?.ws);
    this.streams.onFill((fill) => this.fillCbs.forEach((cb) => cb(fill)));
  }

  async init(): Promise<void> {
    await this.rest.syncTime();
    await this.getSymbols();
    await this.streams.startUserStream();
  }

  async getSymbols(): Promise<SymbolInfo[]> {
    if (Date.now() - this.symbolsLoadedAt > 60 * 60_000) {
      const path = this.market === 'spot' ? '/api/v3/exchangeInfo' : '/fapi/v1/exchangeInfo';
      const info = await this.rest.public<{ symbols: RawSymbol[] }>(path);
      this.symbols.clear();
      for (const s of info.symbols) {
        if (s.status !== 'TRADING') continue;
        if (this.market === 'futures' && s.contractType !== 'PERPETUAL') continue;
        const f = (type: string) => s.filters.find((x) => x.filterType === type);
        const lot = f('LOT_SIZE');
        const priceF = f('PRICE_FILTER');
        const notional = f('MIN_NOTIONAL') ?? f('NOTIONAL');
        this.symbols.set(s.symbol, {
          symbol: s.symbol,
          base: s.baseAsset,
          quote: s.quoteAsset,
          tickSize: Number(priceF?.tickSize ?? 0.00000001),
          stepSize: Number(lot?.stepSize ?? 0.00000001),
          minQty: Number(lot?.minQty ?? 0),
          minNotional: Number(notional?.minNotional ?? notional?.notional ?? 0),
        });
      }
      this.symbolsLoadedAt = Date.now();
    }
    return [...this.symbols.values()];
  }

  async symbolInfo(symbol: string): Promise<SymbolInfo | undefined> {
    await this.getSymbols();
    return this.symbols.get(symbol);
  }

  async getBalances(): Promise<Balance[]> {
    if (this.market === 'spot') {
      const acct = await this.rest.signed<{ balances: { asset: string; free: string; locked: string }[] }>(
        'GET',
        '/api/v3/account',
      );
      return acct.balances
        .map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
        .filter((b) => b.free > 0 || b.locked > 0);
    }
    const assets = await this.rest.signed<{ asset: string; availableBalance: string; balance: string }[]>(
      'GET',
      '/fapi/v2/balance',
    );
    return assets
      .map((a) => ({
        asset: a.asset,
        free: Number(a.availableBalance),
        locked: Number(a.balance) - Number(a.availableBalance),
      }))
      .filter((b) => b.free > 0 || b.locked > 0);
  }

  async accountEquity(): Promise<AccountEquity | null> {
    // Spot has no single "equity" figure — let callers sum balances instead.
    if (this.market === 'spot') return null;
    // /fapi/v2/account gives the authoritative totals Binance shows, correct
    // across multi-asset collateral and unrealized PnL — unlike summing the
    // per-asset USDT wallet, which undercounts a multi-asset account.
    const a = await this.rest.signed<{
      totalWalletBalance: string;
      totalUnrealizedProfit: string;
      totalMarginBalance: string;
      availableBalance: string;
      positions?: { notional: string }[];
    }>('GET', '/fapi/v2/account');
    const positionValue = (a.positions ?? []).reduce((s, p) => s + Math.abs(Number(p.notional) || 0), 0);
    return {
      equity: Number(a.totalMarginBalance),
      available: Number(a.availableBalance),
      wallet: Number(a.totalWalletBalance),
      unrealizedPnl: Number(a.totalUnrealizedProfit),
      positionValue,
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (this.market === 'spot') return [];
    const raw = await this.rest.signed<
      {
        symbol: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        unRealizedProfit: string;
        leverage: string;
        marginType: string;
        positionSide?: string;
      }[]
    >('GET', '/fapi/v2/positionRisk');
    return raw
      .filter((p) => Number(p.positionAmt) !== 0)
      .map((p) => ({
        symbol: p.symbol,
        qty: Number(p.positionAmt),
        entryPrice: Number(p.entryPrice),
        markPrice: Number(p.markPrice),
        unrealizedPnl: Number(p.unRealizedProfit),
        leverage: Number(p.leverage),
        marginMode: p.marginType === 'isolated' ? 'isolated' : 'cross',
        positionSide:
          p.positionSide === 'LONG' || p.positionSide === 'SHORT' ? (p.positionSide as 'LONG' | 'SHORT') : undefined,
      }));
  }

  async getOpenOrders(symbol?: string): Promise<OpenOrder[]> {
    const path = this.market === 'spot' ? '/api/v3/openOrders' : '/fapi/v1/openOrders';
    const raw = await this.rest.signed<
      {
        orderId: number;
        symbol: string;
        side: 'BUY' | 'SELL';
        type: string;
        price: string;
        stopPrice: string;
        origQty: string;
        executedQty: string;
        reduceOnly?: boolean;
        clientOrderId: string;
        time: number;
      }[]
    >('GET', path, { symbol });
    return raw.map((o) => ({
      orderId: String(o.orderId),
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      price: Number(o.price),
      stopPrice: Number(o.stopPrice),
      origQty: Number(o.origQty),
      executedQty: Number(o.executedQty),
      reduceOnly: o.reduceOnly ?? false,
      clientId: o.clientOrderId,
      time: o.time,
    }));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const info = await this.symbolInfo(req.symbol);
    if (!info) throw new Error(`Unknown symbol ${req.symbol}`);
    const params: Record<string, string | number | boolean | undefined> = {
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      quantity: formatQty(info, req.qty),
      newClientOrderId: req.clientId,
    };
    if (req.type === 'LIMIT' || req.type === 'STOP') {
      params.price = formatPrice(info, req.price ?? 0);
      params.timeInForce = 'GTC';
    }
    if (req.type === 'STOP_MARKET' || req.type === 'TAKE_PROFIT_MARKET' || req.type === 'STOP') {
      params.stopPrice = formatPrice(info, req.stopPrice ?? 0);
    }
    if (this.market === 'futures' && req.positionSide) {
      // Hedge mode: closing is an opposite-side order carrying positionSide;
      // Binance rejects an explicit reduceOnly flag in dual-side mode.
      params.positionSide = req.positionSide;
    } else if (this.market === 'futures' && req.reduceOnly) {
      params.reduceOnly = true;
    }
    const path = this.market === 'spot' ? '/api/v3/order' : '/fapi/v1/order';
    const raw = await this.rest.signed<{
      orderId: number;
      status: OrderResult['status'];
      executedQty: string;
      avgPrice?: string;
      cummulativeQuoteQty?: string;
    }>('POST', path, params);
    const executed = Number(raw.executedQty ?? 0);
    const avg =
      Number(raw.avgPrice ?? 0) ||
      (executed > 0 && raw.cummulativeQuoteQty ? Number(raw.cummulativeQuoteQty) / executed : 0);
    return { orderId: String(raw.orderId), status: raw.status, executedQty: executed, avgPrice: avg };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    const path = this.market === 'spot' ? '/api/v3/order' : '/fapi/v1/order';
    await this.rest.signed('DELETE', path, { symbol, orderId });
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (this.market !== 'futures') return;
    await this.rest.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  async setMarginMode(symbol: string, mode: 'cross' | 'isolated'): Promise<void> {
    if (this.market !== 'futures') return;
    try {
      await this.rest.signed('POST', '/fapi/v1/marginType', {
        symbol,
        marginType: mode === 'isolated' ? 'ISOLATED' : 'CROSSED',
      });
    } catch (e) {
      // code -4046: "No need to change margin type" — already set.
      if (!(e instanceof Error && e.message.includes('-4046'))) throw e;
    }
  }

  async setPositionMode(dual: boolean): Promise<void> {
    if (this.market !== 'futures') return;
    try {
      await this.rest.signed('POST', '/fapi/v1/positionSide/dual', { dualSidePosition: dual });
    } catch (e) {
      // code -4059: "No need to change position side" — already set.
      if (!(e instanceof Error && e.message.includes('-4059'))) throw e;
    }
  }

  async getPrice(symbol: string): Promise<number> {
    const cached = this.streams.lastPrice(symbol);
    if (cached) return cached;
    const path = this.market === 'spot' ? '/api/v3/ticker/price' : '/fapi/v1/ticker/price';
    const t = await this.rest.public<{ price: string }>(path, { symbol });
    return Number(t.price);
  }

  async getTickers(): Promise<Ticker[]> {
    const path = this.market === 'spot' ? '/api/v3/ticker/24hr' : '/fapi/v1/ticker/24hr';
    const raw = await this.rest.public<
      { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[]
    >(path);
    return raw.map((t) => ({
      symbol: t.symbol,
      last: Number(t.lastPrice),
      changePct: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
    }));
  }

  async getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    const path = this.market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
    const raw = await this.rest.public<(string | number)[][]>(path, { symbol, interval, limit });
    return raw.map((k) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]),
    }));
  }

  onFill(cb: (fill: FillEvent) => void): void {
    this.fillCbs.push(cb);
  }

  watchPrice(symbol: string): void {
    this.streams.watchPrice(symbol);
  }

  onPrice(cb: (symbol: string, price: number) => void): void {
    this.streams.onPrice(cb);
  }

  watchCandles(symbol: string, interval: string): void {
    this.streams.watchCandles(symbol, interval);
  }

  onCandleClose(cb: (symbol: string, interval: string, candle: Kline) => void): void {
    this.streams.onCandleClose(cb);
  }

  async close(): Promise<void> {
    await this.streams.close();
  }
}
