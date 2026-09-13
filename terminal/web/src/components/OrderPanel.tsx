import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { GridConfig, TpOrderSpec } from '../types';
import { DEFAULT_GRID, GridFields, gridPreviewPrices } from './GridFields';
import { NumberInput } from './NumberInput';
import { parseSignal, type ParsedSignal } from '../signalParse';

type SizeUnit = 'usd' | 'base' | 'freePct' | 'fullPct' | 'fullPctLev';
const CANDLE_TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d', '1w'];

export function OrderPanel() {
  const { market, symbol, prices, tickers, balances, positions, setSymbol, setError, loadAccountState } = useStore();
  const account = useStore((s) => s.account());

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'market' | 'limit' | 'stop_market'>('market');
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('usd');
  const [size, setSize] = useState<number>(100);
  const [limitPrice, setLimitPrice] = useState<number | undefined>(undefined);
  const [stopPrice, setStopPrice] = useState<number | undefined>(undefined);
  const [leverage, setLeverage] = useState(5);
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('cross');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const [gridOn, setGridOn] = useState(false);
  const [grid, setGrid] = useState<GridConfig>(DEFAULT_GRID);
  const [tpOn, setTpOn] = useState(false);
  const [tpOrders, setTpOrders] = useState<TpOrderSpec[]>([{ ofsPct: 1, price: 0, piecePct: 100 }]);
  const [slOn, setSlOn] = useState(false);
  const [slOfs, setSlOfs] = useState(3);
  const [slPrice, setSlPrice] = useState<number | undefined>(undefined);
  const [slTrig, setSlTrig] = useState('price'); // 'price' or a candle timeframe
  const [beTp, setBeTp] = useState(0); // move stop to breakeven after this many TPs (0 = off)
  const [slxOn, setSlxOn] = useState(false);
  const [slxAct, setSlxAct] = useState(1);
  const [slxTrail, setSlxTrail] = useState(0.5);
  const [slxTrig, setSlxTrig] = useState('price');

  // Paste-a-signal importer.
  const [signalOpen, setSignalOpen] = useState(false);
  const [signalText, setSignalText] = useState('');
  const [parsed, setParsed] = useState<ParsedSignal | null>(null);

  const lastPrice = prices[symbol] ?? tickers.find((t) => t.symbol === symbol)?.last ?? 0;
  const quoteFree = balances.find((b) => b.asset === 'USDT')?.free ?? 0;
  // Account equity ("full portfolio"): USDT wallet (free+locked) + open uPnL.
  const equity =
    balances.filter((b) => b.asset === 'USDT').reduce((s, b) => s + b.free + b.locked, 0) +
    positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const setPreview = useStore((s) => s.setPreview);
  const setApplyPreviewDrag = useStore((s) => s.setApplyPreviewDrag);
  const setTp = (i: number, patch: Partial<TpOrderSpec>) =>
    setTpOrders((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  // Let the chart apply drags of preview lines back to these inputs.
  useEffect(() => {
    setApplyPreviewDrag((e) => {
      if (e.kind === 'sl') {
        setSlPrice(e.price);
        return;
      }
      if (e.kind === 'tp') {
        setTpOrders((prev) => prev.map((o, i) => (i === e.index ? { ...o, price: e.price } : o)));
        return;
      }
      // entry
      if (gridOn) {
        setGrid((prev) => {
          const n = Math.max(2, Math.min(30, Math.round(prev.count || 2)));
          const levels = Array.from({ length: n }, (_, i) => prev.levels?.[i] ?? { price: 0 });
          if (e.index < levels.length) levels[e.index] = { ...levels[e.index], price: e.price };
          return { ...prev, priceMode: 'levels', levels };
        });
      } else if (type === 'limit') {
        setLimitPrice(e.price);
      } else if (type === 'stop_market') {
        setStopPrice(e.price);
      }
    });
    return () => setApplyPreviewDrag(null);
  }, [gridOn, type, setApplyPreviewDrag]);

  // Live preview of the order being configured, drawn on the chart in realtime.
  useEffect(() => {
    const dir = side === 'buy' ? 1 : -1; // long → +, short → -
    let entries: number[] = [];
    if (gridOn) entries = gridPreviewPrices(grid, side, lastPrice);
    else if (type === 'limit' && limitPrice) entries = [limitPrice];
    else if (type === 'stop_market' && stopPrice) entries = [stopPrice];
    const entryRef = entries.length ? entries.reduce((a, b) => a + b, 0) / entries.length : lastPrice;

    const tps =
      tpOn && entryRef > 0
        ? tpOrders
            .map((o) => (o.price > 0 ? o.price : entryRef * (1 + (dir * o.ofsPct) / 100)))
            .filter((p) => p > 0)
        : [];
    const sl =
      slOn && entryRef > 0
        ? (slPrice ?? 0) > 0
          ? slPrice
          : entryRef * (1 - (dir * slOfs) / 100)
        : undefined;

    const entriesDraggable = gridOn ? (grid.priceMode ?? 'offset') === 'levels' : type === 'limit' || type === 'stop_market';
    setPreview({ symbol, market, side, entries, entriesDraggable, tps, sl });
    return () => setPreview(null);
  }, [
    symbol, market, side, type, gridOn, grid, limitPrice, stopPrice,
    tpOn, tpOrders, slOn, slOfs, slPrice, lastPrice, setPreview,
  ]);

  const qty = useMemo(() => {
    if (!Number.isFinite(size) || size <= 0) return 0;
    const ref = (limitPrice ?? 0) > 0 && type !== 'market' && !gridOn ? (limitPrice as number) : lastPrice;
    if (ref <= 0) return 0;
    const lev = market === 'futures' ? leverage : 1;
    if (sizeUnit === 'base') return size;
    if (sizeUnit === 'usd') return size / ref;
    if (sizeUnit === 'freePct') return ((quoteFree * size) / 100) * lev / ref;
    if (sizeUnit === 'fullPct') return (equity * size) / 100 / ref;
    // fullPctLev
    return ((equity * size) / 100) * lev / ref;
  }, [size, sizeUnit, lastPrice, limitPrice, type, gridOn, quoteFree, equity, leverage, market]);

  // Apply a parsed signal to the form (never auto-submits — user reviews & fires).
  const applySignal = (p: ParsedSignal) => {
    if (p.symbol && p.symbol !== symbol) setSymbol(p.symbol);
    if (p.side) setSide(p.side);
    if (p.entries.length >= 2) {
      setGridOn(true);
      setGrid({ ...DEFAULT_GRID, count: p.entries.length, priceMode: 'levels', levels: p.entries.map((price) => ({ price })) });
    } else if (p.entries.length === 1) {
      setGridOn(false);
      setType('limit');
      setLimitPrice(p.entries[0]);
    }
    if (p.tps.length) {
      setTpOn(true);
      const n = p.tps.length;
      const even = Math.floor(100 / n);
      setTpOrders(p.tps.map((price, i) => ({ ofsPct: 0, price, piecePct: i === n - 1 ? 100 - even * (n - 1) : even })));
    }
    if (p.sl) {
      setSlOn(true);
      setSlPrice(p.sl.price);
      setSlTrig(p.sl.trigger === 'candle' && p.sl.candleTf ? p.sl.candleTf : 'price');
    }
    setSignalOpen(false);
  };

  const submit = async () => {
    setBusy(true);
    try {
      // Portfolio-percentage sizing is resolved server-side against live equity,
      // so send the amount spec instead of a client-computed quantity.
      const amount =
        sizeUnit === 'fullPct'
          ? { mode: 'full_balance_pct', value: size }
          : sizeUnit === 'fullPctLev'
            ? { mode: 'full_balance_pct_lev', value: size }
            : undefined;
      await api.placeOrder({
        accountId: account,
        market,
        symbol,
        side,
        type,
        qty: amount ? undefined : qty,
        amount,
        price: type === 'limit' && !gridOn ? limitPrice || undefined : undefined,
        stopPrice: type === 'stop_market' && !gridOn ? stopPrice || undefined : undefined,
        reduceOnly: reduceOnly || undefined,
        leverage: market === 'futures' ? leverage : undefined,
        marginMode: market === 'futures' ? marginMode : undefined,
        grid: gridOn && !reduceOnly ? grid : undefined,
        tp: tpOn
          ? { enabled: true, orderType: 'limit', orders: tpOrders, reorderLevels: true, updateBySignal: false }
          : undefined,
        // Send the SL block when the SL module is on OR breakeven-after-TP is
        // set (breakeven works independently of an initial stop).
        sl: slOn || beTp > 0
          ? {
              enabled: slOn,
              ofsPct: slOfs,
              price: slPrice || 0,
              orderType: 'stop_market',
              reorderAfterDca: true,
              breakevenAfterTp: beTp,
              trigger: slTrig === 'price' ? 'price' : 'candle',
              candleTf: slTrig === 'price' ? '1m' : slTrig,
            }
          : undefined,
        slx: slxOn
          ? {
              enabled: true,
              activationOfsPct: slxAct,
              trailPct: slxTrail,
              trigger: slxTrig === 'price' ? 'price' : 'candle',
              candleTf: slxTrig === 'price' ? '1m' : slxTrig,
            }
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
    <>
    <div className="order-panel">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="panel-title" style={{ padding: 0 }}>Create order — {symbol}</div>
        <button className="ghost" style={{ fontSize: 12 }} onClick={() => { setParsed(null); setSignalOpen(true); }}>
          ⇩ Paste signal
        </button>
      </div>
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
        <select value={gridOn ? 'limit' : type} disabled={gridOn} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="market">Market</option>
          <option value="limit">Limit</option>
          <option value="stop_market">Stop-Market</option>
        </select>
        {gridOn ? (
          <span className="dim" style={{ fontSize: 12 }}>
            entry prices set by the grid below
          </span>
        ) : (
          <>
            {type === 'limit' && (
              <NumberInput allowEmpty placeholder="price" value={limitPrice} onChange={setLimitPrice} />
            )}
            {type === 'stop_market' && (
              <NumberInput allowEmpty placeholder="stop price" value={stopPrice} onChange={setStopPrice} />
            )}
          </>
        )}
      </div>

      <div className="row">
        <label>Size</label>
        <NumberInput value={size} onChange={(v) => setSize(v ?? 0)} />
        <select value={sizeUnit} onChange={(e) => setSizeUnit(e.target.value as SizeUnit)}>
          <option value="usd">USDT</option>
          <option value="base">{symbol.replace('USDT', '')}</option>
          <option value="freePct">% free{market === 'futures' ? ' × lev' : ''}</option>
          <option value="fullPct">% portfolio</option>
          {market === 'futures' && <option value="fullPctLev">% portfolio × lev</option>}
        </select>
      </div>
      <div className="row dim" style={{ fontSize: 12 }}>
        ≈ {qty > 0 ? qty.toPrecision(6) : '—'} {symbol.replace('USDT', '')} · free {quoteFree.toFixed(2)} · portfolio{' '}
        {equity.toFixed(2)} USDT
      </div>

      {market === 'futures' && (
        <div className="row">
          <label>Leverage</label>
          <NumberInput integer min={1} max={125} value={leverage} onChange={(v) => setLeverage(v ?? 1)} />
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
        {gridOn && <GridFields grid={grid} onChange={setGrid} side={side} />}
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
                <NumberInput value={o.ofsPct} disabled={o.price > 0} title="offset %" onChange={(v) => setTp(i, { ofsPct: v ?? 0 })} />
                <span className="dim">% or</span>
                <NumberInput allowEmpty placeholder="price" title="Absolute price; overrides % when set" value={o.price} onChange={(v) => setTp(i, { price: v ?? 0 })} />
                <NumberInput value={o.piecePct} onChange={(v) => setTp(i, { piecePct: v ?? 0 })} />
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
            <NumberInput value={slOfs} disabled={(slPrice ?? 0) > 0} onChange={(v) => setSlOfs(v ?? 0)} />
            <span className="dim">or</span>
            <NumberInput allowEmpty placeholder="price" title="Absolute stop price; overrides % when set" value={slPrice} onChange={setSlPrice} />
            <select
              title="Price touch fires instantly; a candle option fires only when that candle closes beyond the level (server must be running)"
              value={slTrig}
              onChange={(e) => setSlTrig(e.target.value)}
            >
              <option value="price">Touch</option>
              {CANDLE_TFS.map((tf) => (
                <option key={tf} value={tf}>
                  {tf} close
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="row">
          <label title="Move the stop to break-even (entry) after this many TPs fill. Works even with SL and Trailing off (0 = off).">
            Breakeven after TP#
          </label>
          <NumberInput integer value={beTp} onChange={(v) => setBeTp(v ?? 0)} />
          <span className="dim" style={{ fontSize: 12 }}>
            0 = off
          </span>
        </div>
      </div>

      <div className="module">
        <div className="module-head" onClick={() => setSlxOn(!slxOn)}>
          <input type="checkbox" checked={slxOn} readOnly /> Trailing (SLX)
        </div>
        {slxOn && (
          <>
            <div className="row">
              <label>Activate %</label>
              <NumberInput value={slxAct} onChange={(v) => setSlxAct(v ?? 0)} />
            </div>
            <div className="row">
              <label>Trail %</label>
              <NumberInput value={slxTrail} onChange={(v) => setSlxTrail(v ?? 0)} />
            </div>
            <div className="row">
              <label>Trigger</label>
              <select value={slxTrig} onChange={(e) => setSlxTrig(e.target.value)}>
                <option value="price">Touch</option>
                {CANDLE_TFS.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf} close
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>

      <button className={side} disabled={busy || qty <= 0} onClick={() => void submit()}>
        {busy ? '…' : `${side === 'buy' ? 'Buy / Long' : 'Sell / Short'} ${symbol.replace('USDT', '')}`}
      </button>
    </div>

    {signalOpen && (
      <div className="modal-overlay" onClick={() => setSignalOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="panel-title" style={{ padding: 0 }}>Paste signal</div>
          <div className="dim" style={{ fontSize: 12 }}>
            Paste a call (Discord/Telegram). It fills the order form below — review, then place it.
          </div>
          <textarea
            rows={8}
            style={{ width: '100%' }}
            placeholder={'e.g.\n$API3USDT LONG\nEntry: LIMIT PRICE ($0.2453)\nStoploss: 4H CLOSE BELOW $0.2259\nDCA: $0.2318\nTARGET: $0.3547'}
            value={signalText}
            onChange={(e) => {
              setSignalText(e.target.value);
              setParsed(null);
            }}
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="ghost" onClick={() => setParsed(parseSignal(signalText))}>Parse</button>
          </div>
          {parsed && (
            <div className="module" style={{ gap: 4 }}>
              <div>
                <span className="dim">Symbol</span> {parsed.symbol ?? '—'} ·{' '}
                <span className={parsed.side === 'buy' ? 'pos' : parsed.side === 'sell' ? 'neg' : 'dim'}>
                  {parsed.side ?? '—'}
                </span>
              </div>
              <div className="mono"><span className="dim">Entries </span>{parsed.entries.join(', ') || '—'}</div>
              <div className="mono"><span className="dim">TP </span>{parsed.tps.join(', ') || '—'}</div>
              <div className="mono">
                <span className="dim">SL </span>
                {parsed.sl ? `${parsed.sl.price}${parsed.sl.trigger === 'candle' ? ` (${parsed.sl.candleTf} close)` : ''}` : '—'}
              </div>
              {parsed.warnings.map((w, i) => (
                <div key={i} className="dim" style={{ fontSize: 12 }}>⚠ {w}</div>
              ))}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="ghost" onClick={() => setSignalOpen(false)}>Cancel</button>
            <button className="primary" disabled={!parsed} onClick={() => parsed && applySignal(parsed)}>
              Apply to order
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
