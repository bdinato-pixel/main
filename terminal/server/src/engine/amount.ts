import type { AmountSpec } from '../store/types.js';

export interface AmountCtx {
  /** Reference price used for quote→base conversion. */
  price: number;
  leverage: number;
  /** Free quote balance on the market. */
  freeBalance: number;
  /** Account equity: wallet balance + unrealized PnL (the full portfolio). */
  fullBalance: number;
  /** Total notional value of all open positions (Σ |qty| × mark). */
  positionValue?: number;
  /** Current position, when averaging/closing. */
  positionQty?: number;
  positionEntryPrice?: number;
}

/**
 * Resolve an AmountSpec to a base-asset quantity (Finandy amount modes).
 * Returns 0 when the context can't support the mode.
 */
export function computeBaseQty(spec: AmountSpec, ctx: AmountCtx): number {
  const { price } = ctx;
  if (price <= 0) return 0;
  const v = spec.value;
  if (!Number.isFinite(v) || v <= 0) return 0;
  switch (spec.mode) {
    case 'amount':
      return v;
    case 'volume':
    case 'volume_usd':
      return v / price;
    case 'full_balance_pct':
      return (ctx.fullBalance * v) / 100 / price;
    case 'full_balance_pct_lev':
      return (ctx.fullBalance * v * ctx.leverage) / 100 / price;
    case 'free_balance_pct':
      return (ctx.freeBalance * v) / 100 / price;
    case 'free_balance_pct_lev':
      return (ctx.freeBalance * v * ctx.leverage) / 100 / price;
    case 'total_position_value_pct_lev':
      return ((ctx.positionValue ?? 0) * v * ctx.leverage) / 100 / price;
    case 'position_amount_pct':
      return ((ctx.positionQty ?? 0) * v) / 100;
    case 'position_volume_pct': {
      const volume = (ctx.positionQty ?? 0) * (ctx.positionEntryPrice ?? price);
      return (volume * v) / 100 / price;
    }
    default:
      return 0;
  }
}
