import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { ManagedPosition } from '../types';

type Tab = 'positions' | 'orders' | 'balances' | 'signals' | 'history';

export function BottomTabs() {
  const [tab, setTab] = useState<Tab>('positions');
  return (
    <>
      <div className="tabs">
        {(['positions', 'orders', 'balances', 'signals', 'history'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'positions' && <Positions />}
      {tab === 'orders' && <Orders />}
      {tab === 'balances' && <Balances />}
      {tab === 'signals' && <Signals />}
      {tab === 'history' && <History />}
    </>
  );
}

const fmt = (n: number, d = 4) => n.toLocaleString(undefined, { maximumFractionDigits: d });

function Positions() {
  const { managed, positions, prices, setSymbol, setError, loadAccountState } = useStore();

  const close = async (id: string, fraction: number) => {
    try {
      await api.closePosition(id, fraction);
      await loadAccountState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rows = managed.map((p) => {
    const mark = prices[p.symbol] ?? positions.find((x) => x.symbol === p.symbol)?.markPrice ?? p.entryPrice;
    const dirSign = p.side === 'long' ? 1 : -1;
    const upnl = (mark - p.entryPrice) * p.qty * dirSign;
    const upnlPct = p.entryPrice > 0 ? ((mark - p.entryPrice) / p.entryPrice) * 100 * dirSign * p.leverage : 0;
    return { p, mark, upnl, upnlPct };
  });

  // Exchange positions with no managed record (opened outside the terminal).
  const unmanaged = positions.filter((x) => !managed.some((p) => p.symbol === x.symbol));

  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Pair</th>
          <th>Side</th>
          <th className="num">Qty</th>
          <th className="num">Entry</th>
          <th className="num">Mark</th>
          <th className="num">uPnL</th>
          <th className="num">SL</th>
          <th>TP</th>
          <th>Trail</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ p, mark, upnl, upnlPct }) => (
          <tr key={p.id} onClick={() => setSymbol(p.symbol)} style={{ cursor: 'pointer' }}>
            <td>
              {p.symbol} <span className="dim">×{p.leverage}</span>
              {p.dcaCount > 0 && <span className="pill"> DCA {p.dcaCount}</span>}
            </td>
            <td className={p.side === 'long' ? 'pos' : 'neg'}>{p.side}</td>
            <td className="num mono">{fmt(p.qty, 6)}</td>
            <td className="num mono">{fmt(p.entryPrice)}</td>
            <td className="num mono">{fmt(mark)}</td>
            <td className={`num mono ${upnl >= 0 ? 'pos' : 'neg'}`}>
              {fmt(upnl, 2)} ({upnlPct.toFixed(2)}%)
            </td>
            <td className="num mono">{p.slPrice ?? p.virtualSlPrice ? fmt(p.slPrice ?? p.virtualSlPrice ?? 0) : '—'}</td>
            <td className="mono">
              {(p.tpLevels ?? []).length > 0 ? `${p.tpFilledCount}/${(p.tpLevels ?? []).length + p.tpFilledCount}` : '—'}
            </td>
            <td className="mono">{p.trailing?.armed ? `@${fmt(p.trailing.stopPrice)}` : '—'}</td>
            <td>
              <button onClick={(e) => { e.stopPropagation(); void close(p.id, 0.5); }}>½</button>{' '}
              <button className="sell" onClick={(e) => { e.stopPropagation(); void close(p.id, 1); }}>
                Close
              </button>
            </td>
          </tr>
        ))}
        {unmanaged.map((x) => (
          <tr key={x.symbol} onClick={() => setSymbol(x.symbol)} style={{ cursor: 'pointer' }}>
            <td>
              {x.symbol} <span className="dim">×{x.leverage} (exchange)</span>
            </td>
            <td className={x.qty > 0 ? 'pos' : 'neg'}>{x.qty > 0 ? 'long' : 'short'}</td>
            <td className="num mono">{fmt(Math.abs(x.qty), 6)}</td>
            <td className="num mono">{fmt(x.entryPrice)}</td>
            <td className="num mono">{fmt(x.markPrice)}</td>
            <td className={`num mono ${x.unrealizedPnl >= 0 ? 'pos' : 'neg'}`}>{fmt(x.unrealizedPnl, 2)}</td>
            <td colSpan={4} className="dim">not managed by terminal</td>
          </tr>
        ))}
        {rows.length === 0 && unmanaged.length === 0 && (
          <tr>
            <td colSpan={10} className="dim">
              No open positions
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Orders() {
  const { orders, market, setError, loadAccountState } = useStore();
  const account = useStore((s) => s.account());
  const cancel = async (symbol: string, orderId: string) => {
    try {
      await api.cancelOrder(account, market, symbol, orderId);
      await loadAccountState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Pair</th>
          <th>Side</th>
          <th>Type</th>
          <th className="num">Price</th>
          <th className="num">Stop</th>
          <th className="num">Qty</th>
          <th className="num">Filled</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.orderId}>
            <td>{o.symbol}</td>
            <td className={o.side === 'BUY' ? 'pos' : 'neg'}>
              {o.side}
              {o.reduceOnly && <span className="dim"> (reduce)</span>}
            </td>
            <td>{o.type}</td>
            <td className="num mono">{o.price > 0 ? fmt(o.price) : '—'}</td>
            <td className="num mono">{o.stopPrice > 0 ? fmt(o.stopPrice) : '—'}</td>
            <td className="num mono">{fmt(o.origQty, 6)}</td>
            <td className="num mono">{fmt(o.executedQty, 6)}</td>
            <td>
              <button onClick={() => void cancel(o.symbol, o.orderId)}>Cancel</button>
            </td>
          </tr>
        ))}
        {orders.length === 0 && (
          <tr>
            <td colSpan={8} className="dim">
              No open orders
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Balances() {
  const { balances } = useStore();
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Asset</th>
          <th className="num">Free</th>
          <th className="num">Locked</th>
        </tr>
      </thead>
      <tbody>
        {balances.map((b) => (
          <tr key={b.asset}>
            <td>{b.asset}</td>
            <td className="num mono">{fmt(b.free, 8)}</td>
            <td className="num mono">{fmt(b.locked, 8)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Signals() {
  const { signals } = useStore();
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Time</th>
          <th>Hook</th>
          <th>Action</th>
          <th>Detail</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {signals.map((s) => (
          <tr key={s.id}>
            <td className="mono dim">{new Date(s.receivedAt).toLocaleTimeString()}</td>
            <td>{s.hookName}</td>
            <td className={s.ok ? 'pos' : 'neg'}>{s.action}</td>
            <td>{s.detail}</td>
            <td className="dim mono">{s.sourceIp}</td>
          </tr>
        ))}
        {signals.length === 0 && (
          <tr>
            <td colSpan={5} className="dim">
              No signals received yet
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function History() {
  const [rows, setRows] = useState<ManagedPosition[]>([]);
  useEffect(() => {
    void api.positionHistory().then(setRows).catch(() => {});
  }, []);
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Closed</th>
          <th>Pair</th>
          <th>Side</th>
          <th className="num">Qty</th>
          <th className="num">Entry</th>
          <th className="num">Realized PnL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id}>
            <td className="mono dim">{p.closedAt ? new Date(p.closedAt).toLocaleString() : ''}</td>
            <td>{p.symbol}</td>
            <td className={p.side === 'long' ? 'pos' : 'neg'}>{p.side}</td>
            <td className="num mono">{fmt(p.qty, 6)}</td>
            <td className="num mono">{fmt(p.entryPrice)}</td>
            <td className={`num mono ${p.realizedPnl >= 0 ? 'pos' : 'neg'}`}>{fmt(p.realizedPnl, 2)}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="dim">
              No closed positions
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
