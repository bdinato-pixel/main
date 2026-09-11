import type { SymbolInfo } from '../exchange/types.js';

/** Count decimals implied by a filter step like 0.001. */
function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  const s = step.toExponential();
  const [mantissa, exp] = s.split('e');
  const extra = (mantissa.split('.')[1] ?? '').length;
  return Math.max(0, -Number(exp) + extra);
}

function floorToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const d = decimalsOf(step);
  // Round the division result to dodge float noise (0.1/0.001 = 99.999...).
  const units = Math.floor(Number((value / step).toFixed(8)));
  return Number((units * step).toFixed(d));
}

export function quantizeQty(info: SymbolInfo, qty: number): number {
  return floorToStep(qty, info.stepSize);
}

export function quantizePrice(info: SymbolInfo, price: number): number {
  return floorToStep(price, info.tickSize);
}

export function formatQty(info: SymbolInfo, qty: number): string {
  return quantizeQty(info, qty).toFixed(decimalsOf(info.stepSize));
}

export function formatPrice(info: SymbolInfo, price: number): string {
  return quantizePrice(info, price).toFixed(decimalsOf(info.tickSize));
}

/**
 * Quantize an order to the symbol's filters. Returns null when the result
 * violates minQty/minNotional (the exchange would reject it).
 */
export function quantizeOrder(
  info: SymbolInfo,
  qty: number,
  price: number,
): { qty: number; price: number } | null {
  const q = quantizeQty(info, qty);
  const p = quantizePrice(info, price);
  if (q <= 0 || q < info.minQty) return null;
  if (info.minNotional > 0 && q * p < info.minNotional) return null;
  return { qty: q, price: p };
}
