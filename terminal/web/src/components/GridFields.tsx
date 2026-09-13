import type { GridConfig, GridLevel } from '../types';

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
  const num = (v: string) => Number(v);
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
        <input type="number" min={2} max={30} value={grid.count} onChange={(e) => setCount(num(e.target.value))} />
        <label>Bounds by</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'offset' | 'price' | 'levels')}>
          <option value="offset">Offset %</option>
          <option value="price">Price range</option>
          <option value="levels">Each price</option>
        </select>
        {mode === 'offset' && (
          <>
            <label>First %</label>
            <input type="number" value={grid.firstOfsPct} onChange={(e) => onChange({ ...grid, firstOfsPct: num(e.target.value) })} />
            <label>Last %</label>
            <input type="number" value={grid.lastOfsPct} onChange={(e) => onChange({ ...grid, lastOfsPct: num(e.target.value) })} />
          </>
        )}
        {mode === 'price' && (
          <>
            <label title="Absolute price of the order nearest current price">First price</label>
            <input type="number" value={grid.firstPrice || ''} onChange={(e) => onChange({ ...grid, firstPrice: num(e.target.value) })} />
            <label title="Absolute price of the farthest order">Last price</label>
            <input type="number" value={grid.lastPrice || ''} onChange={(e) => onChange({ ...grid, lastPrice: num(e.target.value) })} />
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
              <input type="number" value={l.price || ''} placeholder="price" onChange={(e) => setLevel(i, { price: num(e.target.value) })} />
              <label title="Share of the total size for this order; blank orders split the rest evenly">qty %</label>
              <input type="number" value={l.qtyPct ?? ''} placeholder="auto" onChange={(e) => setLevel(i, { qtyPct: e.target.value === '' ? undefined : num(e.target.value) })} />
            </div>
          ))}
          <div className="row dim" style={{ fontSize: 12 }}>
            {grid.count} limit orders at the prices above · blank qty % splits the remainder evenly
          </div>
        </>
      ) : (
        <div className="row">
          <label title="Each next order's quantity is multiplied by this (1 = even)">Qty ×</label>
          <input type="number" step={0.1} value={grid.qtyFactor} onChange={(e) => onChange({ ...grid, qtyFactor: num(e.target.value) })} />
          <label title="1 = even spacing, >1 clusters orders toward the far edge, <1 toward the near edge">Density</label>
          <input type="number" step={0.1} value={grid.density} onChange={(e) => onChange({ ...grid, density: num(e.target.value) })} />
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
