// Domain types for the terminal. The hook/module model mirrors Finandy's
// signal terminal (docs.finandy.com) so existing TradingView alert messages
// keep working unchanged.

export type MarketType = 'spot' | 'futures';
export type SignalSide = 'buy' | 'sell';
export type PositionDir = 'long' | 'short';

/** How an order size is interpreted (Finandy "Order Amount / Volume" modes). */
export type AmountMode =
  | 'amount' // base-asset quantity (tokens/contracts)
  | 'volume' // quote-asset quantity
  | 'volume_usd' // USD notional
  | 'full_balance_pct' // % of (wallet + positions volume + PnL)
  | 'full_balance_pct_lev' // same, multiplied by leverage
  | 'free_balance_pct' // % of available balance
  | 'free_balance_pct_lev' // same, multiplied by leverage
  | 'position_volume_pct' // % of current position volume (DCA/close only)
  | 'position_amount_pct'; // % of current position base amount (DCA/close only)

export interface AmountSpec {
  mode: AmountMode;
  value: number;
}

export type EntryOrderType = 'market' | 'limit' | 'stop_market';

/**
 * Order grid (Finandy "Order grid"): the amount is spread over `count` limit
 * orders between `firstOfsPct` and `lastOfsPct` from the reference price
 * (below it for longs, above for shorts).
 */
/** One explicit grid order (priceMode 'levels'). */
export interface GridLevel {
  /** Absolute price of this order. */
  price: number;
  /** Optional share of the total quantity (%); blank levels split evenly. */
  qtyPct?: number;
}

export interface GridConfig {
  /** Number of orders, 2..30. */
  count: number;
  /**
   * How the grid orders are placed:
   * - 'offset': spread over first/lastOfsPct as % from the reference price;
   * - 'price':  spread over the absolute first/lastPrice range;
   * - 'levels': one explicit price per order from `levels` (no interpolation).
   */
  priceMode?: 'offset' | 'price' | 'levels';
  /** Absolute price of the order nearest the reference (priceMode 'price'). */
  firstPrice?: number;
  /** Absolute price of the farthest order (priceMode 'price'). */
  lastPrice?: number;
  /** Explicit per-order prices/quantities (priceMode 'levels'). */
  levels?: GridLevel[];
  /** Offset % of the order nearest to the reference price. */
  firstOfsPct: number;
  /** Offset % of the farthest order. */
  lastOfsPct: number;
  /**
   * Quantity multiplier per successive order (Finandy "Amount factor"):
   * 1 = even split, 2 = each next order doubles, 0.5 = halves.
   */
  qtyFactor: number;
  /**
   * Spacing curve (Finandy "Density"): 1 = even spacing, >1 = orders cluster
   * toward the far edge, <1 = toward the near edge.
   */
  density: number;
}

export interface OpenModule {
  enabled: boolean;
  amount: AmountSpec;
  orderType: EntryOrderType;
  /** single = one order; grid = spread the amount over a grid of limit orders. */
  entry: 'single' | 'grid';
  grid: GridConfig;
  /** For limit/stop entries: % offset from the reference (signal/last) price. */
  priceOffsetPct: number;
  /** Futures only. */
  leverage: number;
  marginMode: 'cross' | 'isolated';
  /** Finandy "Position side" limit: both | long_only | short_only | strategy. */
  positionMode: 'both' | 'long_only' | 'short_only' | 'strategy';
  /** Minutes that must pass after the last position on the pair closed. */
  timeoutMin: number;
  /** 0 disables each limit. */
  maxOpenPositions: number;
  maxTotalVolumeUsd: number;
  maxHookPositions: number;
  maxHookVolumeUsd: number;
  blacklist: string[];
  whitelist: string[];
}

export interface DcaModule {
  enabled: boolean;
  amount: AmountSpec;
  orderType: EntryOrderType;
  entry: 'single' | 'grid';
  grid: GridConfig;
  priceOffsetPct: number;
  /** Skip averaging if position volume + order would exceed this (0 = off). */
  maxPositionVolumeUsd: number;
  /** If false, skip averaging while unfilled DCA orders exist on the position. */
  allowWithOpenDcaOrders: boolean;
}

export interface CloseModule {
  enabled: boolean;
  orderType: 'market' | 'limit';
  /** full = close position completely; signal_amount = close by the amount spec. */
  mode: 'full' | 'signal_amount';
  amount: AmountSpec;
  /** Futures one-way mode: close and open the opposite direction. */
  reverse: boolean;
  /** If true, ignore close signals while the position is not in profit. */
  checkProfit: boolean;
  /** Close every open position on this market when a close signal arrives. */
  closeAll: 'off' | 'both' | 'long' | 'short';
}

export interface SlModule {
  enabled: boolean;
  /** % offset from position price (used when no absolute price given). */
  ofsPct: number;
  /** Absolute price, overrides ofsPct when > 0. */
  price: number;
  orderType: 'stop_market' | 'stop_limit';
  /** Recompute SL from the new average price after DCA. */
  reorderAfterDca: boolean;
  /**
   * Move the stop to the position's break-even (average entry) price once
   * this many TP orders have filled (0 = off). Independent of the trailing
   * module — it works whether or not SLX is enabled, and places a stop at
   * breakeven even if no initial SL was set.
   */
  breakevenAfterTp: number;
  /**
   * Trigger source (Finandy): 'price' fires on touch (exchange-resident stop
   * on futures); 'candle' fires only when a candle of candleTf CLOSES beyond
   * the SL level — wick-tolerant, evaluated server-side.
   */
  trigger?: 'price' | 'candle';
  candleTf?: string;
}

/** Trailing stop ("SLX"). Runs virtually on the price stream. */
export interface SlxModule {
  enabled: boolean;
  /** Profit % (from position price) at which trailing arms. */
  activationOfsPct: number;
  /** Distance % the stop trails behind the best price seen. */
  trailPct: number;
  /** 'price' = arm/trail/trigger on every tick; 'candle' = on candle closes. */
  trigger?: 'price' | 'candle';
  candleTf?: string;
}

export interface TpOrderSpec {
  /** % offset from position price; ignored when price > 0. */
  ofsPct: number;
  /** Absolute price (0 = use ofsPct). */
  price: number;
  /** % of the position quantity this level closes. */
  piecePct: number;
}

export interface TpModule {
  enabled: boolean;
  orderType: 'limit' | 'virtual_market' | 'stop_market';
  orders: TpOrderSpec[];
  /**
   * Level reordering: after DCA, recreate TP levels at the same % distance
   * from the NEW position price (true) or keep the old absolute prices (false).
   */
  reorderLevels: boolean;
  /** Accept `"update": true` signals that replace TP levels on an open position. */
  updateBySignal: boolean;
}

/**
 * A webhook connection ("hook"). POST /hook/<id> with a Finandy-style JSON
 * message executes it.
 */
export interface Hook {
  id: string;
  name: string;
  secret: string;
  enabled: boolean;
  accountId: string;
  market: MarketType;
  /** When set, only this pair is traded regardless of the signal symbol. */
  fixedSymbol: string;
  open: OpenModule;
  dca: DcaModule;
  close: CloseModule;
  sl: SlModule;
  slx: SlxModule;
  tp: TpModule;
  /**
   * Option paths controlled from the signal message instead of the saved
   * settings (Finandy's checkbox next to each option), e.g. "open.amount".
   */
  signalControlled: string[];
  createdAt: number;
}

/** Parsed + validated incoming webhook payload (Finandy signal message). */
export interface Signal {
  name: string;
  secret: string;
  side: SignalSide;
  symbol: string;
  /** From strategies: {{strategy.market_position}} → long | short | flat. */
  positionSide?: 'long' | 'short' | 'flat' | 'both';
  /** Signal price ({{close}}), used as reference for limit offsets. */
  price?: number;
  /** Strategy contracts ({{strategy.order.contracts}}). */
  contracts?: number;
  leverage?: number;
  /** Raw module overrides straight from the message. */
  open?: Record<string, unknown>;
  dca?: Record<string, unknown>;
  close?: Record<string, unknown>;
  sl?: Record<string, unknown>;
  slx?: Record<string, unknown>;
  tp?: { orders?: { price?: string | number; ofs?: string | number; piece?: string | number }[]; update?: boolean } & Record<string, unknown>;
  raw: Record<string, unknown>;
}

export type SignalAction = 'open' | 'dca' | 'close' | 'reverse' | 'close_all' | 'update_tp' | 'ignore';

export interface SignalLogEntry {
  id: string;
  hookId: string;
  hookName: string;
  receivedAt: number;
  sourceIp: string;
  payload: unknown;
  action: SignalAction;
  detail: string;
  ok: boolean;
}

/** A position the engine manages (TP/SL/trailing lifecycle). */
export interface ManagedPosition {
  id: string;
  accountId: string;
  market: MarketType;
  symbol: string;
  side: PositionDir;
  qty: number; // base quantity, absolute
  entryPrice: number; // average
  leverage: number;
  marginMode: 'cross' | 'isolated';
  hookId?: string;
  openedAt: number;
  status: 'open' | 'closed';
  closedAt?: number;
  realizedPnl: number;
  dcaCount: number;
  tpOrderIds: string[];
  tpFilledCount: number;
  slOrderId?: string;
  slPrice?: number;
  /** Virtual SL (spot, or candle-triggered) armed at this price. */
  virtualSlPrice?: number;
  /** When set, the virtual SL fires on closes of this candle timeframe. */
  slCandleTf?: string;
  trailing?: {
    armed: boolean;
    bestPrice: number;
    stopPrice: number;
  };
  /** Snapshot of the modules governing this position's lifecycle. */
  config: {
    tp: TpModule;
    sl: SlModule;
    slx: SlxModule;
  };
  /** Virtual TP levels being monitored (orderType virtual_market/stop_market). */
  virtualTp?: { price: number; qty: number }[];
  /** Last planned TP levels (used to keep prices when reordering is off). */
  tpLevels?: { price: number; qty: number }[];
  /** Unfilled entry/DCA grid orders — cancelled when the position closes. */
  entryOrderIds?: string[];
}

export interface ExchangeAccount {
  id: string;
  label: string;
  exchange: 'binance' | 'paper';
  apiKey: string;
  apiSecret: string;
  /** Paper accounts simulate fills locally against live or last-known prices. */
  paperBalanceUsd: number;
  /** Futures dual-side position mode: hold LONG and SHORT on a pair at once. */
  hedgeMode?: boolean;
  createdAt: number;
}

export interface AppSettings {
  accounts: ExchangeAccount[];
  activeAccountId: string;
  /** Restrict webhook callers; empty = allow any source IP. */
  allowedSignalIps: string[];
}

/**
 * An order the engine has placed that is expected to open (or grow) a position
 * once it fills. Persisted so a restart — or a missed user-data fill event —
 * doesn't lose the TP/SL configuration that should be applied when the fill is
 * detected (directly, or by reconciling against the exchange).
 */
export interface PendingIntent {
  accountId: string;
  market: MarketType;
  symbol: string;
  dir: PositionDir;
  hookId?: string;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  config: ManagedPosition['config'];
  /** Unfilled entry/grid order ids to carry onto the position. */
  entryOrderIds?: string[];
  createdAt: number;
}

export interface DbShape {
  settings: AppSettings;
  hooks: Hook[];
  positions: ManagedPosition[];
  signalLog: SignalLogEntry[];
  /** Last known trade timestamps per account:symbol for open-timeout checks. */
  lastCloseAt: Record<string, number>;
  /** Pending open/DCA intents keyed by intent key, awaiting their fill. */
  pendingIntents: Record<string, PendingIntent>;
}
