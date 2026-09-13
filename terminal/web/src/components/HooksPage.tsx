import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { Hook, MarketType } from '../types';
import { DEFAULT_GRID, GridFields } from './GridFields';
import { NumberInput } from './NumberInput';

const CANDLE_TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];

/**
 * Trigger selector for SL/SLX: fire on price touch, or only when a candle
 * of the chosen timeframe closes beyond the level (wick-tolerant).
 */
function TriggerSelect({
  trigger,
  candleTf,
  onChange,
}: {
  trigger?: 'price' | 'candle';
  candleTf?: string;
  onChange: (trigger: 'price' | 'candle', candleTf: string) => void;
}) {
  const value = trigger === 'candle' ? candleTf ?? '1m' : 'price';
  return (
    <select
      title="Price touch fires instantly (exchange-resident stop on futures). Candle close fires only if the candle closes beyond the level — wicks don't trigger it, but it needs the server running."
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'price') onChange('price', candleTf ?? '1m');
        else onChange('candle', v);
      }}
    >
      <option value="price">Price touch</option>
      {CANDLE_TFS.map((tf) => (
        <option key={tf} value={tf}>
          {tf} candle close
        </option>
      ))}
    </select>
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
          <NumberInput value={draft.open.amount.value} onChange={(v) => patch((d) => (d.open.amount.value = v ?? 0))} />
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
                  <NumberInput value={draft.open.priceOffsetPct} onChange={(v) => patch((d) => (d.open.priceOffsetPct = v ?? 0))} />
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
            <NumberInput integer min={1} max={125} value={draft.open.leverage} onChange={(v) => patch((d) => (d.open.leverage = v ?? 1))} />
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
          <NumberInput integer value={draft.open.timeoutMin} onChange={(v) => patch((d) => (d.open.timeoutMin = v ?? 0))} />
          <label>Max positions</label>
          <NumberInput integer value={draft.open.maxOpenPositions} onChange={(v) => patch((d) => (d.open.maxOpenPositions = v ?? 0))} />
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
          <NumberInput value={draft.dca.amount.value} onChange={(v) => patch((d) => (d.dca.amount.value = v ?? 0))} />
          <label>Max pos vol $</label>
          <NumberInput value={draft.dca.maxPositionVolumeUsd} onChange={(v) => patch((d) => (d.dca.maxPositionVolumeUsd = v ?? 0))} />
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
            <NumberInput value={o.ofsPct} disabled={o.price > 0} onChange={(v) => patch((d) => (d.tp.orders[i].ofsPct = v ?? 0))} />
            <label title="Absolute price; overrides offset % when set (0 = use %)">or price</label>
            <NumberInput allowEmpty placeholder="—" value={o.price} onChange={(v) => patch((d) => (d.tp.orders[i].price = v ?? 0))} />
            <label>piece %</label>
            <NumberInput value={o.piecePct} onChange={(v) => patch((d) => (d.tp.orders[i].piecePct = v ?? 0))} />
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
          <NumberInput value={draft.sl.ofsPct} disabled={draft.sl.price > 0} onChange={(v) => patch((d) => (d.sl.ofsPct = v ?? 0))} />
          <label title="Absolute stop price; overrides offset % when set (0 = use %)">or price</label>
          <NumberInput allowEmpty placeholder="—" value={draft.sl.price} onChange={(v) => patch((d) => (d.sl.price = v ?? 0))} />
          <label title="Recompute SL from the new average after DCA">
            <input type="checkbox" checked={draft.sl.reorderAfterDca} onChange={(e) => patch((d) => (d.sl.reorderAfterDca = e.target.checked))} /> reorder after DCA
          </label>
          <label>Trigger</label>
          <TriggerSelect
            trigger={draft.sl.trigger}
            candleTf={draft.sl.candleTf}
            onChange={(trigger, candleTf) =>
              patch((d) => {
                d.sl.trigger = trigger;
                d.sl.candleTf = candleTf;
              })
            }
          />
          <label>
            <input type="checkbox" checked={sc('sl.ofs')} onChange={() => toggleSc('sl.ofs')} /> from signal
          </label>
        </div>
        <div className="row">
          <label title="Move the stop to break-even (entry) once this many TPs fill. Works even with SL and Trailing off (0 = off).">
            Move to breakeven after TP#
          </label>
          <NumberInput integer value={draft.sl.breakevenAfterTp} onChange={(v) => patch((d) => (d.sl.breakevenAfterTp = v ?? 0))} />
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={draft.slx.enabled} onChange={(e) => patch((d) => (d.slx.enabled = e.target.checked))} /> SLX
          </label>
          <label>activate %</label>
          <NumberInput value={draft.slx.activationOfsPct} onChange={(v) => patch((d) => (d.slx.activationOfsPct = v ?? 0))} />
          <label>trail %</label>
          <NumberInput value={draft.slx.trailPct} onChange={(v) => patch((d) => (d.slx.trailPct = v ?? 0))} />
          <label>Trigger</label>
          <TriggerSelect
            trigger={draft.slx.trigger}
            candleTf={draft.slx.candleTf}
            onChange={(trigger, candleTf) =>
              patch((d) => {
                d.slx.trigger = trigger;
                d.slx.candleTf = candleTf;
              })
            }
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
