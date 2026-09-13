import type { GridConfig, GridLevel } from '../types';
import { NumberInput } from './NumberInput';

export const DEFAULT_GRID: GridConfig = {
  count: 4,
  priceMode: 'offset',
  firstPrice: 0,
  lastPrice: 0,
  levels: [],
  firstOfsPct: 0.5,
  lastOfsPct: 3,
  qtyFactor: 1,
  density: 1,
};

/**
 * The prices a grid would place orders at (mirrors the server's planGrid
 * price math, ignoring quantities) — for the chart preview.
 */
export function gridPreviewPrices(grid: GridConfig, side: 'buy' | 'sell', refPrice: number): number[] {
  const count = Math.max(2, Math.min(30, Math.round(grid.count || 2)));
  const mode = grid.priceMode ?? 'offset';
  if (mode === 'levels') return (grid.levels ?? []).slice(0, count).map((l) => l.price).filter((p) => p > 0);

  const density = grid.density > 0 ? grid.density : 1;
  const useAbs = mode === 'price' && (grid.firstPrice ?? 0) > 0 && (grid.lastPrice ?? 0) > 0;
  if (!useAbs && refPrice <= 0) return [];
  const sign = side === 'buy' ? -1 : 1;
  const first = Math.max(0, grid.firstOfsPct);
  const last = Math.max(first, grid.lastOfsPct);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0 : i / (count - 1);
    const t = u ** density;
    const price = useAbs
      ? (grid.firstPrice as number) + ((grid.lastPrice as number) - (grid.firstPrice as number)) * t
      : refPrice * (1 + (sign * (first + (last - first) * t)) / 100);
    if (price > 0) out.push(price);
  }
  return out;
}

/** Resize the explicit-levels array to match `count`, keeping existing rows. */
function levelsForCount(grid: GridConfig): GridLevel[] {
  const n = Math.max(2, Math.min(30, Math.round(grid.count || 2)));
  const cur = grid.levels ?? [];
  return Array.from({ length: n }, (_, i) => cur[i] ?? { price: 0 });
}

/**
 * Order-grid configuration: choose how the orders are placed — spread over a
 * % offset range, over an absolute price range, or one explicit price per
 * order ("Each price"). Shared by the hook editor and the manual order panel.
 */
export function GridFields({
  grid,
  onChange,
  side,
}: {
  grid: GridConfig;
  onChange: (g: GridConfig) => void;
  side?: 'buy' | 'sell';
}) {
  const mode = grid.priceMode ?? 'offset';

  const setMode = (m: 'offset' | 'price' | 'levels') => {
    const next: GridConfig = { ...grid, priceMode: m };
    if (m === 'levels') next.levels = levelsForCount(next);
    onChange(next);
  };

  const setCount = (count: number) => {
    const next: GridConfig = { ...grid, count };
    if (mode === 'levels') next.levels = levelsForCount(next);
    onChange(next);
  };

  const setLevel = (i: number, patch: Partial<GridLevel>) => {
    const levels = levelsForCount(grid).map((l, j) => (j === i ? { ...l, ...patch } : l));
    onChange({ ...grid, levels });
  };

  return (
    <>
      <div className="row">
        <label>Orders</label>
        <NumberInput integer min={2} max={30} value={grid.count} onChange={(v) => setCount(v ?? 2)} />
        <label>Bounds by</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'offset' | 'price' | 'levels')}>
          <option value="offset">Offset %</option>
          <option value="price">Price range</option>
          <option value="levels">Each price</option>
        </select>
        {mode === 'offset' && (
          <>
            <label>First %</label>
            <NumberInput value={grid.firstOfsPct} onChange={(v) => onChange({ ...grid, firstOfsPct: v ?? 0 })} />
            <label>Last %</label>
            <NumberInput value={grid.lastOfsPct} onChange={(v) => onChange({ ...grid, lastOfsPct: v ?? 0 })} />
          </>
        )}
        {mode === 'price' && (
          <>
            <label title="Absolute price of the order nearest current price">First price</label>
            <NumberInput allowEmpty placeholder="price" value={grid.firstPrice} onChange={(v) => onChange({ ...grid, firstPrice: v ?? 0 })} />
            <label title="Absolute price of the farthest order">Last price</label>
            <NumberInput allowEmpty placeholder="price" value={grid.lastPrice} onChange={(v) => onChange({ ...grid, lastPrice: v ?? 0 })} />
          </>
        )}
      </div>

      {mode === 'levels' ? (
        <>
          {levelsForCount(grid).map((l, i) => (
            <div className="row" key={i}>
              <span className="dim" style={{ minWidth: 56 }}>
                Order {i + 1}
              </span>
              <label>price</label>
              <NumberInput allowEmpty placeholder="price" value={l.price} onChange={(v) => setLevel(i, { price: v ?? 0 })} />
              <label title="Share of the total size for this order; blank orders split the rest evenly">qty %</label>
              <NumberInput allowEmpty placeholder="auto" value={l.qtyPct} onChange={(v) => setLevel(i, { qtyPct: v })} />
            </div>
          ))}
          <div className="row dim" style={{ fontSize: 12 }}>
            {grid.count} limit orders at the prices above · blank qty % splits the remainder evenly
          </div>
        </>
      ) : (
        <div className="row">
          <label title="Each next order's quantity is multiplied by this (1 = even)">Qty ×</label>
          <NumberInput value={grid.qtyFactor} onChange={(v) => onChange({ ...grid, qtyFactor: v ?? 1 })} />
          <label title="1 = even spacing, >1 clusters orders toward the far edge, <1 toward the near edge">Density</label>
          <NumberInput value={grid.density} onChange={(v) => onChange({ ...grid, density: v ?? 1 })} />
          {side && mode === 'offset' && (
            <span className="dim" style={{ fontSize: 12 }}>
              {grid.count} orders {grid.firstOfsPct}–{grid.lastOfsPct}% {side === 'buy' ? 'below' : 'above'} price
            </span>
          )}
        </div>
      )}
    </>
  );
}
