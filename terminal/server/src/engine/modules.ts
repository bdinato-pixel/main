import type { GridConfig, PositionDir, SlModule, SlxModule, TpModule } from '../store/types.js';
import type { SymbolInfo } from '../exchange/types.js';
import { quantizePrice, quantizeQty } from './quantizer.js';

export interface PlannedGridOrder {
  price: number;
  qty: number;
}

/**
 * Plan a grid of limit orders (Finandy "Order grid"): `totalQty` base units
 * spread over `grid.count` orders. Bounds come either from firstOfsPct /
 * lastOfsPct as % from the reference price (below it for longs, above for
 * shorts) or, when priceMode is 'price', from the absolute firstPrice /
 * lastPrice. Quantities follow qtyFactor (1 = even, 2 = each next order
 * doubles); spacing follows the density curve (1 = even, >1 clusters toward
 * the far edge, <1 toward the near edge). Orders that fall below exchange
 * minimums are dropped, mirroring how exchanges reject them.
 */
export function planGrid(
  grid: GridConfig,
  dir: PositionDir,
  refPrice: number,
  totalQty: number,
  info: SymbolInfo,
): PlannedGridOrder[] {
  const count = Math.max(2, Math.min(30, Math.round(grid.count)));
  if (totalQty <= 0) return [];
  const density = grid.density > 0 ? grid.density : 1;
  const factor = grid.qtyFactor > 0 ? grid.qtyFactor : 1;

  const useAbsolute =
    grid.priceMode === 'price' && (grid.firstPrice ?? 0) > 0 && (grid.lastPrice ?? 0) > 0;
  if (!useAbsolute && refPrice <= 0) return [];

  const sign = dir === 'long' ? -1 : 1;
  const first = Math.max(0, grid.firstOfsPct);
  const last = Math.max(first, grid.lastOfsPct);
  const firstP = grid.firstPrice ?? 0;
  const lastP = grid.lastPrice ?? 0;

  const weights: number[] = [];
  for (let i = 0; i < count; i++) weights.push(factor ** i);
  const weightSum = weights.reduce((s, w) => s + w, 0);

  const out: PlannedGridOrder[] = [];
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0 : i / (count - 1);
    const t = u ** density;
    const rawPrice = useAbsolute
      ? firstP + (lastP - firstP) * t
      : refPrice * (1 + (sign * (first + (last - first) * t)) / 100);
    const price = quantizePrice(info, rawPrice);
    const qty = quantizeQty(info, (totalQty * weights[i]) / weightSum);
    if (price <= 0 || qty < info.minQty || qty <= 0) continue;
    if (info.minNotional > 0 && qty * price < info.minNotional) continue;
    out.push({ price, qty });
  }
  return out;
}

export interface PlannedTpOrder {
  price: number;
  qty: number;
  piecePct: number;
}

/**
 * Plan TP orders for a position. Prices come from each level's absolute
 * price, or its % offset from the position (avg) price — long above, short
 * below. Quantities split the position by piecePct; the last level absorbs
 * rounding remainders so the sum equals the position quantity.
 */
export function planTpOrders(
  tp: TpModule,
  side: PositionDir,
  entryPrice: number,
  positionQty: number,
  info: SymbolInfo,
): PlannedTpOrder[] {
  if (!tp.enabled || tp.orders.length === 0 || positionQty <= 0) return [];
  const sign = side === 'long' ? 1 : -1;
  const totalPiece = tp.orders.reduce((s, o) => s + Math.max(0, o.piecePct), 0) || 100;
  const planned: PlannedTpOrder[] = [];
  let assigned = 0;
  for (let i = 0; i < tp.orders.length; i++) {
    const level = tp.orders[i];
    const price =
      level.price > 0 ? level.price : entryPrice * (1 + (sign * level.ofsPct) / 100);
    const isLast = i === tp.orders.length - 1;
    let qty: number;
    if (isLast) {
      qty = quantizeQty(info, positionQty - assigned);
    } else {
      qty = quantizeQty(info, (positionQty * Math.max(0, level.piecePct)) / totalPiece);
    }
    if (qty <= 0) continue;
    assigned += qty;
    planned.push({ price: quantizePrice(info, price), qty, piecePct: level.piecePct });
  }
  return planned.filter((o) => o.qty >= info.minQty && (info.minNotional <= 0 || o.qty * o.price >= info.minNotional));
}

/** Stop-loss price: absolute if set, else % offset against the position. */
export function slPrice(sl: SlModule, side: PositionDir, entryPrice: number): number {
  if (sl.price > 0) return sl.price;
  const sign = side === 'long' ? -1 : 1;
  return entryPrice * (1 + (sign * sl.ofsPct) / 100);
}

export interface TrailingState {
  armed: boolean;
  bestPrice: number;
  stopPrice: number;
}

export interface TrailingUpdate extends TrailingState {
  triggered: boolean;
}

/**
 * Advance the trailing-stop state machine on a price tick. Arms when price
 * moves activationOfsPct into profit, then trails trailPct behind the best
 * price; triggers when price falls back to the stop.
 */
export function updateTrailing(
  slx: SlxModule,
  side: PositionDir,
  entryPrice: number,
  state: TrailingState | undefined,
  markPrice: number,
): TrailingUpdate {
  const dirSign = side === 'long' ? 1 : -1;
  const trailFactor = 1 - (dirSign * slx.trailPct) / 100;
  let s: TrailingState = state ?? { armed: false, bestPrice: 0, stopPrice: 0 };

  if (!s.armed) {
    const activation = entryPrice * (1 + (dirSign * slx.activationOfsPct) / 100);
    const reached = side === 'long' ? markPrice >= activation : markPrice <= activation;
    if (!reached) return { ...s, triggered: false };
    s = { armed: true, bestPrice: markPrice, stopPrice: markPrice * trailFactor };
  } else {
    const better = side === 'long' ? markPrice > s.bestPrice : markPrice < s.bestPrice;
    if (better) {
      s = { armed: true, bestPrice: markPrice, stopPrice: markPrice * trailFactor };
    }
  }

  const triggered = side === 'long' ? markPrice <= s.stopPrice : markPrice >= s.stopPrice;
  return { ...s, triggered };
}
