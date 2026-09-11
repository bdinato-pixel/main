import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { GridConfig, Hook, MarketType } from '../types';

const DEFAULT_GRID: GridConfig = { count: 4, firstOfsPct: 0.5, lastOfsPct: 3, qtyFactor: 1, density: 1 };

function GridFields({ grid, onChange }: { grid: GridConfig; onChange: (g: GridConfig) => void }) {
  const num = (v: string) => Number(v);
  return (
    <div className="row">
      <label>Orders</label>
      <input type="number" min={2} max={30} value={grid.count} onChange={(e) => onChange({ ...grid, count: num(e.target.value) })} />
      <label>First %</label>
      <input type="number" value={grid.firstOfsPct} onChange={(e) => onChange({ ...grid, firstOfsPct: num(e.target.value) })} />
      <label>Last %</label>
      <input type="number" value={grid.lastOfsPct} onChange={(e) => onChange({ ...grid, lastOfsPct: num(e.target.value) })} />
      <label title="Each next order's quantity is multiplied by this (1 = even)">Qty ×</label>
      <input type="number" step={0.1} value={grid.qtyFactor} onChange={(e) => onChange({ ...grid, qtyFactor: num(e.target.value) })} />
      <label title="1 = even spacing, >1 clusters orders toward the far edge, <1 toward the near edge">Density</label>
      <input type="number" step={0.1} value={grid.density} onChange={(e) => onChange({ ...grid, density: num(e.target.value) })} />
    </div>
  );
}

export function HooksPage() {
  const { hooks, loadHooks, settings, setError } = useStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = hooks.find((h) => h.id === selectedId) ?? null;

  useEffect(() => {
    void loadHooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createHook = async () => {
    try {
      const hook = await api.createHook({
        name: `Hook ${hooks.length + 1}`,
        accountId: settings?.activeAccountId ?? 'paper',
        market: 'futures',
      });
      await loadHooks();
      setSelectedId(hook.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <div className="hook-grid">
        <div className="hook-list">
          <button className="primary" onClick={() => void createHook()} style={{ width: '100%', marginBottom: 10 }}>
            + New signal hook
          </button>
          {hooks.map((h) => (
            <button
              key={h.id}
              className={`hook-item ${h.id === selectedId ? 'selected' : ''}`}
              onClick={() => setSelectedId(h.id)}
            >
              <strong>{h.name}</strong> <span className={`pill ${h.enabled ? 'on' : 'off'}`}>{h.enabled ? 'on' : 'off'}</span>
              <div className="dim">
                {h.market} · {h.open.positionMode}
              </div>
            </button>
          ))}
          {hooks.length === 0 && <div className="dim">No hooks yet. Create one and paste its URL + message into a TradingView alert.</div>}
        </div>
        {selected ? <HookEditor key={selected.id} hook={selected} /> : <div className="dim">Select a hook to edit.</div>}
      </div>
    </div>
  );
}

function HookEditor({ hook }: { hook: Hook }) {
  const { loadHooks, setError, settings } = useStore();
  const [draft, setDraft] = useState<Hook>(() => JSON.parse(JSON.stringify(hook)) as Hook);
  const [testResult, setTestResult] = useState('');
  const [dirty, setDirty] = useState(false);

  const patch = (fn: (d: Hook) => void) => {
    setDraft((d) => {
      const next = JSON.parse(JSON.stringify(d)) as Hook;
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    try {
      await api.updateHook(hook.id, draft);
      await loadHooks();
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async () => {
    if (!confirm(`Delete hook "${hook.name}"?`)) return;
    await api.deleteHook(hook.id);
    await loadHooks();
  };

  const hookUrl = `${location.origin}/hook/${hook.id}`;

  const message = useMemo(() => {
    const msg: Record<string, unknown> = {
      name: draft.name,
      secret: draft.secret,
      side: 'buy',
      symbol: draft.fixedSymbol || '{{ticker}}',
    };
    if (draft.open.positionMode === 'strategy') msg.positionSide = '{{strategy.market_position}}';
    const sc = new Set(draft.signalControlled);
    if (sc.has('open.amount')) msg.open = { amount: draft.open.amount.value };
    if (sc.has('sl.ofs')) msg.sl = { ofs: draft.sl.ofsPct };
    if (sc.has('tp.orders'))
      msg.tp = { orders: draft.tp.orders.map((o) => ({ ofs: o.ofsPct, price: o.price || '', piece: o.piecePct })) };
    return JSON.stringify(msg, null, 2);
  }, [draft]);

  const sendTest = async (side: 'buy' | 'sell') => {
    try {
      const payload = JSON.parse(message) as Record<string, unknown>;
      payload.side = side;
      if (payload.symbol === '{{ticker}}') payload.symbol = 'BTCUSDT';
      if (payload.positionSide === '{{strategy.market_position}}') payload.positionSide = side === 'buy' ? 'long' : 'short';
      const res = await api.sendTestSignal(hook.id, payload);
      setTestResult(`${res.action}: ${res.detail}`);
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    }
  };

  const sc = (path: string) => draft.signalControlled.includes(path);
  const toggleSc = (path: string) =>
    patch((d) => {
      d.signalControlled = sc(path) ? d.signalControlled.filter((p) => p !== path) : [...d.signalControlled, path];
    });

  const amountModes: [string, string][] = [
    ['amount', 'Amount (tokens)'],
    ['volume', 'Volume (quote)'],
    ['volume_usd', 'Volume, USD'],
    ['full_balance_pct', 'Full balance, %'],
    ['full_balance_pct_lev', 'Full balance % × lev'],
    ['free_balance_pct', 'Free balance, %'],
    ['free_balance_pct_lev', 'Free balance % × lev'],
  ];
  const dcaModes: [string, string][] = [...amountModes, ['position_volume_pct', 'Position volume, %'], ['position_amount_pct', 'Position amount, %']];

  return (
    <div>
      <div className="card">
        <h3>
          Connection{' '}
          <span className={`pill ${draft.enabled ? 'on' : 'off'}`} style={{ cursor: 'pointer' }} onClick={() => patch((d) => (d.enabled = !d.enabled))}>
            {draft.enabled ? 'enabled' : 'disabled'}
          </span>
        </h3>
        <div className="row">
          <label>Name</label>
          <input value={draft.name} onChange={(e) => patch((d) => (d.name = e.target.value))} />
          <label>Secret</label>
          <input value={draft.secret} onChange={(e) => patch((d) => (d.secret = e.target.value))} />
        </div>
        <div className="row">
          <label>Account</label>
          <select value={draft.accountId} onChange={(e) => patch((d) => (d.accountId = e.target.value))}>
            {(settings?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          <label>Market</label>
          <select value={draft.market} onChange={(e) => patch((d) => (d.market = e.target.value as MarketType))}>
            <option value="futures">Futures</option>
            <option value="spot">Spot</option>
          </select>
          <label>Fixed pair</label>
          <input
            placeholder="empty = {{ticker}}"
            value={draft.fixedSymbol}
            onChange={(e) => patch((d) => (d.fixedSymbol = e.target.value.toUpperCase()))}
          />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label>Webhook URL</label>
          <pre className="code" style={{ flex: 1 }}>{hookUrl}</pre>
          <button onClick={() => void navigator.clipboard.writeText(hookUrl)}>Copy</button>
        </div>
      </div>

      <div className="card">
        <h3>Open position</h3>
        <div className="row">
          <label>
            <input type="checkbox" checked={draft.open.enabled} onChange={(e) => patch((d) => (d.open.enabled = e.target.checked))} /> Enabled
          </label>
          <label title="When checked, the value comes from the signal message">
            <input type="checkbox" checked={sc('open.amount')} onChange={() => toggleSc('open.amount')} /> amount from signal
          </label>
        </div>
        <div className="row">
          <label>Amount</label>
          <select
            value={draft.open.amount.mode}
            onChange={(e) => patch((d) => (d.open.amount.mode = e.target.value))}
          >
            {amountModes.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={draft.open.amount.value}
            onChange={(e) => patch((d) => (d.open.amount.value = Number(e.target.value)))}
          />
          <label>Entry</label>
          <select
            value={draft.open.entry ?? 'single'}
            onChange={(e) =>
              patch((d) => {
                d.open.entry = e.target.value as 'single' | 'grid';
                if (d.open.entry === 'grid' && !d.open.grid) d.open.grid = DEFAULT_GRID;
              })
            }
          >
            <option value="single">Single order</option>
            <option value="grid">Order grid</option>
          </select>
          {(draft.open.entry ?? 'single') === 'single' && (
            <>
              <label>Order</label>
              <select value={draft.open.orderType} onChange={(e) => patch((d) => (d.open.orderType = e.target.value))}>
                <option value="market">Market</option>
                <option value="limit">Limit</option>
                <option value="stop_market">Stop-Market</option>
              </select>
              {draft.open.orderType !== 'market' && (
                <>
                  <label>Offset %</label>
                  <input
                    type="number"
                    value={draft.open.priceOffsetPct}
                    onChange={(e) => patch((d) => (d.open.priceOffsetPct = Number(e.target.value)))}
                  />
                </>
              )}
            </>
          )}
        </div>
        {draft.open.entry === 'grid' && (
          <GridFields grid={draft.open.grid ?? DEFAULT_GRID} onChange={(g) => patch((d) => (d.open.grid = g))} />
        )}
        {draft.market === 'futures' && (
          <div className="row">
            <label>Leverage</label>
            <input
              type="number"
              min={1}
              max={125}
              value={draft.open.leverage}
              onChange={(e) => patch((d) => (d.open.leverage = Number(e.target.value)))}
            />
            <select value={draft.open.marginMode} onChange={(e) => patch((d) => (d.open.marginMode = e.target.value as 'cross' | 'isolated'))}>
              <option value="cross">Cross</option>
              <option value="isolated">Isolated</option>
            </select>
          </div>
        )}
        <div className="row">
          <label>Position side</label>
          <select value={draft.open.positionMode} onChange={(e) => patch((d) => (d.open.positionMode = e.target.value))}>
            <option value="both">Both (reversals)</option>
            <option value="strategy">Strategy (positionSide)</option>
            <option value="long_only">Long only</option>
            <option value="short_only">Short only</option>
          </select>
          <label>Timeout, min</label>
          <input type="number" value={draft.open.timeoutMin} onChange={(e) => patch((d) => (d.open.timeoutMin = Number(e.target.value)))} />
          <label>Max positions</label>
          <input
            type="number"
            value={draft.open.maxOpenPositions}
            onChange={(e) => patch((d) => (d.open.maxOpenPositions = Number(e.target.value)))}
          />
        </div>
        <div className="row">
          <label>Whitelist</label>
          <input
            placeholder="BTCUSDT, ETHUSDT…"
            value={draft.open.whitelist.join(',')}
            onChange={(e) => patch((d) => (d.open.whitelist = e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)))}
          />
          <label>Blacklist</label>
          <input
            value={draft.open.blacklist.join(',')}
            onChange={(e) => patch((d) => (d.open.blacklist = e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)))}
          />
        </div>
      </div>

      <div className="card">
        <h3>Averaging (DCA)</h3>
        <div className="row">
          <label>
            <input type="checkbox" checked={draft.dca.enabled} onChange={(e) => patch((d) => (d.dca.enabled = e.target.checked))} /> Enabled
          </label>
          <label>Amount</label>
          <select value={draft.dca.amount.mode} onChange={(e) => patch((d) => (d.dca.amount.mode = e.target.value))}>
            {dcaModes.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <input type="number" value={draft.dca.amount.value} onChange={(e) => patch((d) => (d.dca.amount.value = Number(e.target.value)))} />
          <label>Max pos vol $</label>
          <input
            type="number"
            value={draft.dca.maxPositionVolumeUsd}
            onChange={(e) => patch((d) => (d.dca.maxPositionVolumeUsd = Number(e.target.value)))}
          />
          <label>Entry</label>
          <select
            value={draft.dca.entry ?? 'single'}
            onChange={(e) =>
              patch((d) => {
                d.dca.entry = e.target.value as 'single' | 'grid';
                if (d.dca.entry === 'grid' && !d.dca.grid) d.dca.grid = DEFAULT_GRID;
              })
            }
          >
            <option value="single">Single order</option>
            <option value="grid">Order grid</option>
          </select>
        </div>
        {draft.dca.entry === 'grid' && (
          <GridFields grid={draft.dca.grid ?? DEFAULT_GRID} onChange={(g) => patch((d) => (d.dca.grid = g))} />
        )}
      </div>

      <div className="card">
        <h3>Close / Reverse</h3>
        <div className="row">
          <label>
            <input type="checkbox" checked={draft.close.enabled} onChange={(e) => patch((d) => (d.close.enabled = e.target.checked))} /> Enabled
          </label>
          <select value={draft.close.mode} onChange={(e) => patch((d) => (d.close.mode = e.target.value))}>
            <option value="full">Close position completely</option>
            <option value="signal_amount">Close/reverse by amount</option>
          </select>
          <label title="Futures one-way mode: close and open the opposite direction">
            <input type="checkbox" checked={draft.close.reverse} onChange={(e) => patch((d) => (d.close.reverse = e.target.checked))} /> Reverse
          </label>
          <label title="Ignore close signals while the position is losing">
            <input type="checkbox" checked={draft.close.checkProfit} onChange={(e) => patch((d) => (d.close.checkProfit = e.target.checked))} /> Check profit
          </label>
          <label>Close ALL</label>
          <select value={draft.close.closeAll} onChange={(e) => patch((d) => (d.close.closeAll = e.target.value))}>
            <option value="off">off</option>
            <option value="both">both</option>
            <option value="long">long only</option>
            <option value="short">short only</option>
          </select>
        </div>
      </div>

      <div className="card">
        <h3>Take Profit (TP)</h3>
        <div className="row">
          <label>
            <input type="checkbox" checked={draft.tp.enabled} onChange={(e) => patch((d) => (d.tp.enabled = e.target.checked))} /> Enabled
          </label>
          <label title="After DCA, recreate TP at the same % distance from the new average price">
            <input type="checkbox" checked={draft.tp.reorderLevels} onChange={(e) => patch((d) => (d.tp.reorderLevels = e.target.checked))} /> Level reordering
          </label>
          <label title='Accept "update": true signals replacing TP levels'>
            <input type="checkbox" checked={draft.tp.updateBySignal} onChange={(e) => patch((d) => (d.tp.updateBySignal = e.target.checked))} /> Update by signal
          </label>
          <label>
            <input type="checkbox" checked={sc('tp.orders')} onChange={() => toggleSc('tp.orders')} /> levels from signal
          </label>
        </div>
        {draft.tp.orders.map((o, i) => (
          <div className="row" key={i}>
            <span className="dim">TP{i + 1}</span>
            <label>offset %</label>
            <input
              type="number"
              value={o.ofsPct}
              onChange={(e) => patch((d) => (d.tp.orders[i].ofsPct = Number(e.target.value)))}
            />
            <label>piece %</label>
            <input
              type="number"
              value={o.piecePct}
              onChange={(e) => patch((d) => (d.tp.orders[i].piecePct = Number(e.target.value)))}
            />
            {draft.tp.orders.length > 1 && (
              <button className="ghost" onClick={() => patch((d) => d.tp.orders.splice(i, 1))}>
                ✕
              </button>
            )}
          </div>
        ))}
        <button className="ghost" onClick={() => patch((d) => d.tp.orders.push({ ofsPct: (d.tp.orders.at(-1)?.ofsPct ?? 0) + 1, price: 0, piecePct: 0 }))}>
          + level
        </button>
      </div>

      <div className="card">
        <h3>Stop Loss (SL) &amp; Trailing (SLX)</h3>
        <div className="row">
          <label>
            <input type="checkbox" checked={draft.sl.enabled} onChange={(e) => patch((d) => (d.sl.enabled = e.target.checked))} /> SL
          </label>
          <label>offset %</label>
          <input type="number" value={draft.sl.ofsPct} onChange={(e) => patch((d) => (d.sl.ofsPct = Number(e.target.value)))} />
          <label title="Recompute SL from the new average after DCA">
            <input type="checkbox" checked={draft.sl.reorderAfterDca} onChange={(e) => patch((d) => (d.sl.reorderAfterDca = e.target.checked))} /> reorder after DCA
          </label>
          <label>
            <input type="checkbox" checked={sc('sl.ofs')} onChange={() => toggleSc('sl.ofs')} /> from signal
          </label>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={draft.slx.enabled} onChange={(e) => patch((d) => (d.slx.enabled = e.target.checked))} /> SLX
          </label>
          <label>activate %</label>
          <input
            type="number"
            value={draft.slx.activationOfsPct}
            onChange={(e) => patch((d) => (d.slx.activationOfsPct = Number(e.target.value)))}
          />
          <label>trail %</label>
          <input type="number" value={draft.slx.trailPct} onChange={(e) => patch((d) => (d.slx.trailPct = Number(e.target.value)))} />
          <label>BE after TP#</label>
          <input
            type="number"
            value={draft.slx.breakevenAfterTp}
            onChange={(e) => patch((d) => (d.slx.breakevenAfterTp = Number(e.target.value)))}
          />
        </div>
      </div>

      <div className="card">
        <h3>TradingView signal message</h3>
        <p className="dim" style={{ marginTop: 0 }}>
          Paste the URL into the alert's Webhook URL field and this JSON into the message. For sell alerts change{' '}
          <code>"side": "buy"</code> to <code>"side": "sell"</code>.
        </p>
        <pre className="code">{message}</pre>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => void navigator.clipboard.writeText(message)}>Copy message</button>
          <button onClick={() => void sendTest('buy')}>Send test BUY</button>
          <button onClick={() => void sendTest('sell')}>Send test SELL</button>
          {testResult && <span className="mono dim">{testResult}</span>}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 24 }}>
        <button className="primary" disabled={!dirty} onClick={() => void save()}>
          Save hook
        </button>
        <button className="sell" onClick={() => void remove()}>
          Delete
        </button>
      </div>
    </div>
  );
}
