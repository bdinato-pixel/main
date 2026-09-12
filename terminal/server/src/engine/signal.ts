import { z } from 'zod';
import type { Hook, Signal, TpOrderSpec } from '../store/types.js';

const num = z.union([z.number(), z.string()]).transform((v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
});

const moduleObj = z.record(z.unknown()).optional();

/**
 * Finandy-style webhook message. Only name/secret/side/symbol are required;
 * everything else refines the hook's saved settings when the matching option
 * is signal-controlled.
 */
const signalSchema = z.object({
  name: z.string().min(1),
  secret: z.string(),
  side: z.enum(['buy', 'sell']),
  symbol: z.string().min(1),
  positionSide: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(['long', 'short', 'flat', 'both']))
    .optional(),
  price: num.optional(),
  contracts: num.optional(),
  leverage: num.optional(),
  open: moduleObj,
  dca: moduleObj,
  close: moduleObj,
  sl: moduleObj,
  slx: moduleObj,
  tp: moduleObj,
});

export class SignalError extends Error {}

export function parseSignal(body: unknown): Signal {
  const parsed = signalSchema.safeParse(body);
  if (!parsed.success) {
    throw new SignalError(`Invalid signal message: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const d = parsed.data;
  return {
    name: d.name,
    secret: d.secret,
    side: d.side,
    symbol: normalizeSymbol(d.symbol),
    positionSide: d.positionSide,
    price: d.price,
    contracts: d.contracts,
    leverage: d.leverage,
    open: d.open,
    dca: d.dca,
    close: d.close,
    sl: d.sl,
    slx: d.slx,
    tp: d.tp as Signal['tp'],
    raw: body as Record<string, unknown>,
  };
}

/** TradingView tickers arrive like "BINANCE:BTCUSDT" or "BTCUSDT.P". */
export function normalizeSymbol(symbol: string): string {
  let s = symbol.toUpperCase().trim();
  const colon = s.lastIndexOf(':');
  if (colon >= 0) s = s.slice(colon + 1);
  s = s.replace(/\.P$/u, '');
  return s;
}

function asNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the effective hook config for one signal: start from the saved hook
 * and apply overrides from the message for options marked signal-controlled.
 *
 * Recognized override keys per module (Finandy-style short names):
 *   open/dca:  amount|volume (number), enabled (bool), leverage (number)
 *   close:     enabled (bool), amount|volume (number)
 *   sl:        enabled (bool), ofs (%), price
 *   slx:       enabled (bool), ofs (activation %), trail (%)
 *   tp:        enabled (bool), orders: [{ofs, price, piece}], update (bool)
 */
export function effectiveHook(hook: Hook, signal: Signal): Hook {
  const h: Hook = structuredClone(hook);
  const controlled = new Set(hook.signalControlled);
  const allow = (path: string) => controlled.has(path);

  for (const mod of ['open', 'dca'] as const) {
    const src = signal[mod];
    if (!src) continue;
    const amount = asNumber(src.amount ?? src.volume);
    if (amount !== undefined && allow(`${mod}.amount`)) h[mod].amount.value = amount;
    if (typeof src.enabled === 'boolean' && allow(`${mod}.enabled`)) h[mod].enabled = src.enabled;
    const lev = asNumber(src.leverage);
    if (mod === 'open' && lev !== undefined && allow('open.leverage')) h.open.leverage = lev;
  }
  if (signal.leverage !== undefined && allow('open.leverage')) h.open.leverage = signal.leverage;
  if (signal.contracts !== undefined && allow('open.amount')) {
    h.open.amount = { mode: 'amount', value: signal.contracts };
    h.dca.amount = { mode: 'amount', value: signal.contracts };
  }

  if (signal.close) {
    if (typeof signal.close.enabled === 'boolean' && allow('close.enabled')) h.close.enabled = signal.close.enabled;
    const amount = asNumber(signal.close.amount ?? signal.close.volume);
    if (amount !== undefined && allow('close.amount')) h.close.amount.value = amount;
  }

  if (signal.sl) {
    if (typeof signal.sl.enabled === 'boolean' && allow('sl.enabled')) h.sl.enabled = signal.sl.enabled;
    const ofs = asNumber(signal.sl.ofs);
    if (ofs !== undefined && allow('sl.ofs')) h.sl.ofsPct = ofs;
    const price = asNumber(signal.sl.price);
    if (price !== undefined && allow('sl.price')) h.sl.price = price;
  }

  if (signal.slx) {
    if (typeof signal.slx.enabled === 'boolean' && allow('slx.enabled')) h.slx.enabled = signal.slx.enabled;
    const ofs = asNumber(signal.slx.ofs);
    if (ofs !== undefined && allow('slx.ofs')) h.slx.activationOfsPct = ofs;
    const trail = asNumber(signal.slx.trail);
    if (trail !== undefined && allow('slx.trail')) h.slx.trailPct = trail;
  }

  if (signal.tp) {
    if (typeof signal.tp.enabled === 'boolean' && allow('tp.enabled')) h.tp.enabled = signal.tp.enabled;
    if (Array.isArray(signal.tp.orders) && (allow('tp.orders') || signal.tp.update === true)) {
      const orders = signalTpOrders(signal);
      if (orders.length > 0) h.tp.orders = orders;
    }
  }

  return h;
}

/** Convert `tp.orders` from a message ({ofs, price, piece}) to TpOrderSpec[]. */
export function signalTpOrders(signal: Signal): TpOrderSpec[] {
  const raw = signal.tp?.orders ?? [];
  const out: TpOrderSpec[] = [];
  for (const o of raw) {
    const price = asNumber(o.price) ?? 0;
    const ofs = asNumber(o.ofs) ?? 0;
    const piece = asNumber(o.piece) ?? 0;
    if (price <= 0 && ofs <= 0) continue;
    out.push({ price, ofsPct: ofs, piecePct: piece });
  }
  // Distribute missing pieces evenly.
  const missing = out.filter((o) => o.piecePct <= 0);
  if (missing.length > 0) {
    const assigned = out.reduce((s, o) => s + Math.max(0, o.piecePct), 0);
    const rest = Math.max(0, 100 - assigned) / missing.length;
    for (const o of missing) o.piecePct = rest;
  }
  return out;
}
