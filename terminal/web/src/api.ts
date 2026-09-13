import type {
  Balance,
  ExchangePosition,
  Hook,
  Kline,
  ManagedPosition,
  MarketType,
  OpenOrder,
  Settings,
  SignalLogEntry,
  SymbolInfo,
  Ticker,
} from './types';

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const qs = (account: string, market: MarketType, extra: Record<string, string | number> = {}) =>
  new URLSearchParams({ account, market, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) }).toString();

export const api = {
  hooks: () => req<Hook[]>('/api/hooks'),
  createHook: (data: { name: string; accountId: string; market: MarketType }) =>
    req<Hook>('/api/hooks', { method: 'POST', body: JSON.stringify(data) }),
  updateHook: (id: string, patch: Partial<Hook>) =>
    req<Hook>(`/api/hooks/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteHook: (id: string) => req<{ ok: boolean }>(`/api/hooks/${id}`, { method: 'DELETE' }),
  sendTestSignal: (hookId: string, payload: unknown) =>
    req<{ ok: boolean; action: string; detail: string }>(`/hook/${hookId}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  signals: () => req<SignalLogEntry[]>('/api/signals'),
  settings: () => req<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    req<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  addAccount: (data: {
    label: string;
    exchange: string;
    apiKey: string;
    apiSecret: string;
    paperBalanceUsd: number;
    hedgeMode: boolean;
  }) => req('/api/accounts', { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: string, patch: { label?: string; hedgeMode?: boolean; paperBalanceUsd?: number }) =>
    req(`/api/accounts/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteAccount: (id: string) => req(`/api/accounts/${id}`, { method: 'DELETE' }),

  accountState: (account: string, market: MarketType) =>
    req<{ balances: Balance[]; positions: ExchangePosition[]; orders: OpenOrder[]; managed: ManagedPosition[] }>(
      `/api/account/state?${qs(account, market)}`,
    ),
  symbols: (account: string, market: MarketType) => req<SymbolInfo[]>(`/api/symbols?${qs(account, market)}`),
  tickers: (account: string, market: MarketType) => req<Ticker[]>(`/api/tickers?${qs(account, market)}`),
  klines: (account: string, market: MarketType, symbol: string, interval: string) =>
    req<Kline[]>(`/api/klines?${qs(account, market, { symbol, interval, limit: 500 })}`),
  watch: (account: string, market: MarketType, symbol: string) =>
    req<{ ok: boolean }>('/api/watch', { method: 'POST', body: JSON.stringify({ accountId: account, market, symbol }) }),

  placeOrder: (order: Record<string, unknown>) =>
    req<{ ok: boolean; orderId: string }>('/api/orders', { method: 'POST', body: JSON.stringify(order) }),
  cancelOrder: (account: string, market: MarketType, symbol: string, orderId: string) =>
    req(`/api/orders/${symbol}/${orderId}?${qs(account, market)}`, { method: 'DELETE' }),
  closePosition: (id: string, fraction: number) =>
    req(`/api/positions/${id}/close`, { method: 'POST', body: JSON.stringify({ fraction }) }),
  positionHistory: () => req<ManagedPosition[]>('/api/positions/history'),
};

export type WsMessage =
  | { type: 'hello' }
  | { type: 'changed' }
  | { type: 'price'; symbol: string; price: number }
  | { type: 'log'; entry: { level: string; message: string; time: number } };

export function connectWs(onMessage: (msg: WsMessage) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as WsMessage);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 2000);
    };
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
