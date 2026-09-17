import { createHmac } from 'node:crypto';
import type { MarketType } from '../../store/types.js';

export const BINANCE_BASE = {
  spot: process.env.BINANCE_SPOT_BASE ?? 'https://api.binance.com',
  futures: process.env.BINANCE_FUTURES_BASE ?? 'https://fapi.binance.com',
} as const;

export const BINANCE_WS = {
  spot: process.env.BINANCE_SPOT_WS ?? 'wss://stream.binance.com:9443',
  futures: process.env.BINANCE_FUTURES_WS ?? 'wss://fstream.binance.com',
} as const;

/** Keyless market-data mirror that works from geo-restricted networks (spot only). */
export const BINANCE_VISION = {
  base: 'https://data-api.binance.vision',
  ws: 'wss://data-stream.binance.vision',
} as const;

export class BinanceApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number,
    message: string,
  ) {
    super(`Binance ${httpStatus} (code ${code}): ${message}`);
  }
}

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

type Params = Record<string, string | number | boolean | undefined>;

/**
 * Minimal signed REST client for Binance spot (/api) and USDT-M futures
 * (/fapi). Only the endpoints the terminal needs.
 */
export class BinanceRest {
  private timeOffset = 0;
  private lastSyncAt = 0;
  private syncing: Promise<void> | null = null;
  /** Re-sync the clock offset if it's older than this (guards drift over days). */
  private static readonly SYNC_TTL_MS = 5 * 60_000;

  constructor(
    readonly market: MarketType,
    private readonly creds: BinanceCredentials,
    private readonly base = BINANCE_BASE[market],
  ) {}

  /** Ensure the clock offset is fresh before signing; de-dupes concurrent syncs. */
  private async ensureFreshTime(): Promise<void> {
    if (Date.now() - this.lastSyncAt <= BinanceRest.SYNC_TTL_MS) return;
    if (!this.syncing) {
      this.syncing = this.syncTime()
        .catch(() => {})
        .finally(() => {
          this.syncing = null;
        });
    }
    await this.syncing;
  }

  private qs(params: Params): string {
    const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
    return new URLSearchParams(clean.map(([k, v]) => [k, String(v)])).toString();
  }

  async public<T>(path: string, params: Params = {}): Promise<T> {
    const query = this.qs(params);
    const res = await fetch(`${this.base}${path}${query ? `?${query}` : ''}`);
    return this.parse<T>(res);
  }

  async signed<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Params = {},
    retry = true,
  ): Promise<T> {
    await this.ensureFreshTime();
    const query = this.qs({
      ...params,
      timestamp: Date.now() + this.timeOffset,
      recvWindow: 10_000,
    });
    const signature = createHmac('sha256', this.creds.apiSecret).update(query).digest('hex');
    const url = `${this.base}${path}?${query}&signature=${signature}`;
    const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': this.creds.apiKey } });
    try {
      return await this.parse<T>(res);
    } catch (e) {
      // -1021: timestamp out of the exchange's window (clock drift) — force a
      // fresh time sync and retry once.
      if (retry && e instanceof BinanceApiError && e.code === -1021) {
        this.lastSyncAt = 0;
        await this.syncTime().catch(() => {});
        return this.signed<T>(method, path, params, false);
      }
      throw e;
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    const looksJson = /^\s*[[{]/.test(text);
    let body: unknown = {};
    if (text && looksJson) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    if (!res.ok) {
      const e = body as { code?: number; msg?: string };
      // Binance JSON errors carry code/msg; edge failures (e.g. an nginx "410
      // Gone" HTML page) don't — use the status text instead of dumping HTML.
      const message = e.msg ?? (res.statusText || 'request failed');
      throw new BinanceApiError(res.status, e.code ?? 0, message);
    }
    return body as T;
  }

  /** Sync local clock offset against the exchange (avoids -1021 errors). */
  async syncTime(): Promise<void> {
    const path = this.market === 'spot' ? '/api/v3/time' : '/fapi/v1/time';
    const t0 = Date.now();
    const { serverTime } = await this.public<{ serverTime: number }>(path);
    const t1 = Date.now();
    // Compensate for round-trip latency (assume symmetric): the server clock at
    // t1 ≈ serverTime + rtt/2.
    this.timeOffset = serverTime + Math.round((t1 - t0) / 2) - t1;
    this.lastSyncAt = Date.now();
  }

  // ---- listen key (user data stream) ----
  async createListenKey(): Promise<string> {
    const path = this.market === 'spot' ? '/api/v3/userDataStream' : '/fapi/v1/listenKey';
    // Listen-key endpoints authenticate via API key header only (no signature).
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': this.creds.apiKey },
    });
    const body = await this.parse<{ listenKey: string }>(res);
    return body.listenKey;
  }

  async keepAliveListenKey(listenKey: string): Promise<void> {
    const path = this.market === 'spot' ? `/api/v3/userDataStream?listenKey=${listenKey}` : '/fapi/v1/listenKey';
    await fetch(`${this.base}${path}`, {
      method: 'PUT',
      headers: { 'X-MBX-APIKEY': this.creds.apiKey },
    });
  }
}
