import { create } from 'zustand';
import { api } from './api';
import type {
  Balance,
  ExchangePosition,
  Hook,
  ManagedPosition,
  MarketType,
  OpenOrder,
  OrderPreview,
  PreviewDrag,
  Settings,
  SignalLogEntry,
  SymbolInfo,
  Ticker,
} from './types';

interface AppState {
  market: MarketType;
  symbol: string;
  interval: string;
  settings: Settings | null;
  hooks: Hook[];
  symbols: SymbolInfo[];
  tickers: Ticker[];
  balances: Balance[];
  positions: ExchangePosition[];
  managed: ManagedPosition[];
  orders: OpenOrder[];
  signals: SignalLogEntry[];
  prices: Record<string, number>;
  preview: OrderPreview | null;
  /** Set by the order panel so the chart can apply drags back to its inputs. */
  applyPreviewDrag: ((e: PreviewDrag) => void) | null;
  error: string | null;

  account: () => string;
  setMarket: (m: MarketType) => void;
  setSymbol: (s: string) => void;
  setInterval: (i: string) => void;
  setError: (e: string | null) => void;
  setPrice: (symbol: string, price: number) => void;
  setPreview: (p: OrderPreview | null) => void;
  setApplyPreviewDrag: (fn: ((e: PreviewDrag) => void) | null) => void;
  loadStatic: () => Promise<void>;
  loadAccountState: () => Promise<void>;
  loadHooks: () => Promise<void>;
  loadSignals: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  market: 'futures',
  symbol: 'BTCUSDT',
  interval: '15m',
  settings: null,
  hooks: [],
  symbols: [],
  tickers: [],
  balances: [],
  positions: [],
  managed: [],
  orders: [],
  signals: [],
  prices: {},
  preview: null,
  applyPreviewDrag: null,
  error: null,

  account: () => get().settings?.activeAccountId ?? 'paper',

  setMarket: (market) => {
    set({ market });
    void get().refreshAll();
  },
  setSymbol: (symbol) => set({ symbol }),
  setInterval: (interval) => set({ interval }),
  setError: (error) => set({ error }),
  setPrice: (symbol, price) => set((s) => ({ prices: { ...s.prices, [symbol]: price } })),
  setPreview: (preview) => set({ preview }),
  setApplyPreviewDrag: (applyPreviewDrag) => set({ applyPreviewDrag }),

  loadStatic: async () => {
    try {
      const settings = await api.settings();
      set({ settings });
      const { market } = get();
      const account = settings.activeAccountId;
      const [symbols, tickers] = await Promise.all([api.symbols(account, market), api.tickers(account, market)]);
      set({ symbols, tickers, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadAccountState: async () => {
    try {
      const { market } = get();
      const state = await api.accountState(get().account(), market);
      set({ ...state, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadHooks: async () => {
    try {
      set({ hooks: await api.hooks() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  loadSignals: async () => {
    try {
      set({ signals: await api.signals() });
    } catch {
      /* signal log is non-critical */
    }
  },

  refreshAll: async () => {
    await get().loadStatic();
    await Promise.all([get().loadAccountState(), get().loadHooks(), get().loadSignals()]);
  },
}));
