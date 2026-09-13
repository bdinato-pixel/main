// Mirrors of the server's wire types (kept minimal on purpose).

export type MarketType = 'spot' | 'futures';

export interface AmountSpec {
  mode: string;
  value: number;
}

export interface TpOrderSpec {
  ofsPct: number;
  price: number;
  piecePct: number;
}

export interface GridLevel {
  price: number;
  qtyPct?: number;
}

export interface GridConfig {
  count: number;
  priceMode?: 'offset' | 'price' | 'levels';
  firstPrice?: number;
  lastPrice?: number;
  levels?: GridLevel[];
  firstOfsPct: number;
  lastOfsPct: number;
  qtyFactor: number;
  density: number;
}

export interface Hook {
  id: string;
  name: string;
  secret: string;
  enabled: boolean;
  accountId: string;
  market: MarketType;
  fixedSymbol: string;
  open: {
    enabled: boolean;
    amount: AmountSpec;
    orderType: string;
    entry?: 'single' | 'grid';
    grid?: GridConfig;
    priceOffsetPct: number;
    leverage: number;
    marginMode: 'cross' | 'isolated';
    positionMode: string;
    timeoutMin: number;
    maxOpenPositions: number;
    maxTotalVolumeUsd: number;
    maxHookPositions: number;
    maxHookVolumeUsd: number;
    blacklist: string[];
    whitelist: string[];
  };
  dca: {
    enabled: boolean;
    amount: AmountSpec;
    orderType: string;
    entry?: 'single' | 'grid';
    grid?: GridConfig;
    priceOffsetPct: number;
    maxPositionVolumeUsd: number;
    allowWithOpenDcaOrders: boolean;
  };
  close: {
    enabled: boolean;
    orderType: string;
    mode: string;
    amount: AmountSpec;
    reverse: boolean;
    checkProfit: boolean;
    closeAll: string;
  };
  sl: {
    enabled: boolean;
    ofsPct: number;
    price: number;
    orderType: string;
    reorderAfterDca: boolean;
    breakevenAfterTp: number;
    trigger?: 'price' | 'candle';
    candleTf?: string;
  };
  slx: {
    enabled: boolean;
    activationOfsPct: number;
    trailPct: number;
    trigger?: 'price' | 'candle';
    candleTf?: string;
  };
  tp: {
    enabled: boolean;
    orderType: string;
    orders: TpOrderSpec[];
    reorderLevels: boolean;
    updateBySignal: boolean;
  };
  signalControlled: string[];
  createdAt: number;
}

export interface SymbolInfo {
  symbol: string;
  base: string;
  quote: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  changePct: number;
  quoteVolume: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
}

export interface ExchangePosition {
  symbol: string;
  qty: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  marginMode: string;
}

export interface OpenOrder {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: string;
  price: number;
  stopPrice: number;
  origQty: number;
  executedQty: number;
  reduceOnly: boolean;
  time: number;
}

export interface ManagedPosition {
  id: string;
  accountId: string;
  market: MarketType;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entryPrice: number;
  leverage: number;
  hookId?: string;
  openedAt: number;
  status: string;
  closedAt?: number;
  realizedPnl: number;
  dcaCount: number;
  tpFilledCount: number;
  slPrice?: number;
  virtualSlPrice?: number;
  trailing?: { armed: boolean; bestPrice: number; stopPrice: number };
  tpLevels?: { price: number; qty: number }[];
}

export interface SignalLogEntry {
  id: string;
  hookId: string;
  hookName: string;
  receivedAt: number;
  sourceIp: string;
  payload: unknown;
  action: string;
  detail: string;
  ok: boolean;
}

export interface Account {
  id: string;
  label: string;
  exchange: 'binance' | 'paper';
  apiKey: string;
  apiSecret: string;
  paperBalanceUsd: number;
  hedgeMode?: boolean;
}

export interface Settings {
  accounts: Account[];
  activeAccountId: string;
  allowedSignalIps: string[];
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
