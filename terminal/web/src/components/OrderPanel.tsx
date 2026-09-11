import { useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { GridConfig, TpOrderSpec } from '../types';

type SizeUnit = 'usd' | 'base' | 'freePct';

export function OrderPanel() {
  const { market, symbol, prices, tickers, balances, setError, loadAccountState } = useStore();
  const account = useStore((s) => s.account());

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'market' | 'limit' | 'stop_market'>('market');
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('usd');
  const [size, setSize] = useState('100');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [leverage, setLeverage] = useState(5);
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('cross');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const [gridOn, setGridOn] = useState(false);
  const [grid, setGrid] = useState<GridConfig>({ count: 4, firstOfsPct: 0.5, lastOfsPct: 3, qtyFactor: 1, density: 1 });
  const [tpOn, setTpOn] = useState(false);
  const [tpOrders, setTpOrders] = useState<TpOrderSpec[]>([{ ofsPct: 1, price: 0, piecePct: 100 }]);
  const [slOn, setSlOn] = useState(false);
  const [slOfs, setSlOfs] = useState(3);
  const [slxOn, setSlxOn] = useState(false);
  const [slxAct, setSlxAct] = useState(1);
  const [slxTrail, setSlxTrail] = useState(0.5);
  const [slxBe, setSlxBe] = useState(0);

  const lastPrice = prices[symbol] ?? tickers.find((t) => t.symbol === symbol)?.last ?? 0;
  const quoteFree = balances.find((b) => b.asset === 'USDT')?.free ?? 0;

  const qty = useMemo(() => {
    const v = Number(size);
    if (!Number.isFinite(v) || v <= 0) return 0;
    const ref = Number(limitPrice) > 0 && type !== 'market' ? Number(limitPrice) : lastPrice;
    if (ref <= 0) return 0;
    if (sizeUnit === 'base') return v;
    if (sizeUnit === 'usd') return v / ref;
    return ((quoteFree * v) / 100) * (market === 'futures' ? leverage : 1) / ref;
  }, [size, sizeUnit, lastPrice, limitPrice, type, quoteFree, leverage, market]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.placeOrder({
        accountId: account,
        market,
        symbol,
        side,
        type,
        qty,
        price: type === 'limit' ? Number(limitPrice) || undefined : undefined,
        stopPrice: type === 'stop_market' ? Number(stopPrice) || undefined : undefined,
        reduceOnly: reduceOnly || undefined,
        leverage: market === 'futures' ? leverage : undefined,
        marginMode: market === 'futures' ? marginMode : undefined,
        grid: gridOn && !reduceOnly ? grid : undefined,
        tp: tpOn
          ? { enabled: true, orderType: 'limit', orders: tpOrders, reorderLevels: true, updateBySignal: false }
          : undefined,
        sl: slOn
          ? { enabled: true, ofsPct: slOfs, price: 0, orderType: 'stop_market', reorderAfterDca: true }
          : undefined,
        slx: slxOn
          ? { enabled: true, activationOfsPct: slxAct, trailPct: slxTrail, breakevenAfterTp: slxBe }
          : undefined,
      });
      setError(null);
      await loadAccountState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="order-panel">
      <div className="panel-title">Create order — {symbol}</div>
      <div className="side-toggle">
        <button className={`buy ${side === 'buy' ? 'selected' : ''}`} onClick={() => setSide('buy')}>
          Buy / Long
        </button>
        <button className={`sell ${side === 'sell' ? 'selected' : ''}`} onClick={() => setSide('sell')}>
          Sell / Short
        </button>
      </div>

      <div className="row">
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="market">Market</option>
          <option value="limit">Limit</option>
          <option value="stop_market">Stop-Market</option>
        </select>
        {type === 'limit' && (
          <input type="number" placeholder="price" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
        )}
        {type === 'stop_market' && (
          <input type="number" placeholder="stop price" value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} />
        )}
      </div>

      <div className="row">
        <label>Size</label>
        <input type="number" value={size} onChange={(e) => setSize(e.target.value)} />
        <select value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as SizeUnit)}>
          <option value="usd">USDT</option>
          <option value="base">{symbol.replace('USDT', '')}</option>
          <option value="freePct">% free{market === 'futures' ? ' × lev' : ''}</option>
        </select>
      </div>
      <div className="row dim" style={{ fontSize: 12 }}>
        ≈ {qty > 0 ? qty.toPrecision(6) : '—'} {symbol.replace('USDT', '')} · free {quoteFree.toFixed(2)} USDT
      </div>

      {market === 'futures' && (
        <div className="row">
          <label>Leverage</label>
          <input type="number" min={1} max={125} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
          <select value={marginMode} onChange={(e) => setMarginMode(e.target.value as 'cross' | 'isolated')}>
            <option value="cross">Cross</option>
            <option value="isolated">Isolated</option>
          </select>
          <label style={{ minWidth: 0 }}>
            <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> reduce
          </label>
        </div>
      )}

      <div className="module">
        <div className="module-head" onClick={() => setGridOn(!gridOn)}>
          <input type="checkbox" checked={gridOn} readOnly /> Order grid
        </div>
        {gridOn && (
          <>
            <div className="row">
              <label>Orders</label>
              <input type="number" min={2} max={30} value={grid.count} onChange={(e) => setGrid({ ...grid, count: Number(e.target.value) })} />
              <label>Qty ×</label>
              <input type="number" step={0.1} value={grid.qtyFactor} onChange={(e) => setGrid({ ...grid, qtyFactor: Number(e.target.value) })} />
            </div>
            <div className="row">
              <label>First %</label>
              <input type="number" step={0.1} value={grid.firstOfsPct} onChange={(e) => setGrid({ ...grid, firstOfsPct: Number(e.target.value) })} />
              <label>Last %</label>
              <input type="number" step={0.1} value={grid.lastOfsPct} onChange={(e) => setGrid({ ...grid, lastOfsPct: Number(e.target.value) })} />
            </div>
            <div className="row dim" style={{ fontSize: 12 }}>
              {grid.count} limit orders spread {grid.firstOfsPct}–{grid.lastOfsPct}% {side === 'buy' ? 'below' : 'above'} price
            </div>
          </>
        )}
      </div>

      <div className="module">
        <div className="module-head" onClick={() => setTpOn(!tpOn)}>
          <input type="checkbox" checked={tpOn} readOnly /> Take Profit (TP)
        </div>
        {tpOn && (
          <>
            {tpOrders.map((o, i) => (
              <div className="row" key={i}>
                <span className="dim">TP{i + 1}</span>
                <input
                  type="number"
                  value={o.ofsPct}
                  onChange={(e) => {
                    const next = [...tpOrders];
                    next[i] = { ...o, ofsPct: Number(e.target.value) };
                    setTpOrders(next);
                  }}
                />
                <span className="dim">% ·</span>
                <input
                  type="number"
                  value={o.piecePct}
                  onChange={(e) => {
                    const next = [...tpOrders];
                    next[i] = { ...o, piecePct: Number(e.target.value) };
                    setTpOrders(next);
                  }}
                />
                <span className="dim">% qty</span>
                {tpOrders.length > 1 && (
                  <button className="ghost" onClick={() => setTpOrders(tpOrders.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button
              className="ghost"
              onClick={() => {
                const even = Math.floor(100 / (tpOrders.length + 1));
                setTpOrders([
                  ...tpOrders.map((o) => ({ ...o, piecePct: even })),
                  { ofsPct: (tpOrders.at(-1)?.ofsPct ?? 1) + 1, price: 0, piecePct: 100 - even * tpOrders.length },
                ]);
              }}
            >
              + level
            </button>
          </>
        )}
      </div>

      <div className="module">
        <div className="module-head" onClick={() => setSlOn(!slOn)}>
          <input type="checkbox" checked={slOn} readOnly /> Stop Loss (SL)
        </div>
        {slOn && (
          <div className="row">
            <label>Offset %</label>
            <input type="number" value={slOfs} onChange={(e) => setSlOfs(Number(e.target.value))} />
          </div>
        )}
      </div>

      <div className="module">
        <div className="module-head" onClick={() => setSlxOn(!slxOn)}>
          <input type="checkbox" checked={slxOn} readOnly /> Trailing (SLX)
        </div>
        {slxOn && (
          <>
            <div className="row">
              <label>Activate %</label>
              <input type="number" value={slxAct} onChange={(e) => setSlxAct(Number(e.target.value))} />
            </div>
            <div className="row">
              <label>Trail %</label>
              <input type="number" value={slxTrail} onChange={(e) => setSlxTrail(Number(e.target.value))} />
            </div>
            <div className="row">
              <label>BE after TP#</label>
              <input type="number" value={slxBe} onChange={(e) => setSlxBe(Number(e.target.value))} />
            </div>
          </>
        )}
      </div>

      <button className={side} disabled={busy || qty <= 0} onClick={() => void submit()}>
        {busy ? '…' : `${side === 'buy' ? 'Buy / Long' : 'Sell / Short'} ${symbol.replace('USDT', '')}`}
      </button>
    </div>
  );
}
