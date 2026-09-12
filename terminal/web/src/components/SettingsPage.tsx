import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

export function SettingsPage() {
  const { settings, refreshAll, setError } = useStore();
  const [label, setLabel] = useState('');
  const [exchange, setExchange] = useState<'binance' | 'paper'>('binance');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [paperBalance, setPaperBalance] = useState(10_000);
  const [hedgeMode, setHedgeMode] = useState(false);
  const [ips, setIps] = useState(settings?.allowedSignalIps.join(', ') ?? '');

  if (!settings) return <div className="page dim">Loading…</div>;

  const addAccount = async () => {
    try {
      await api.addAccount({ label, exchange, apiKey, apiSecret, paperBalanceUsd: paperBalance, hedgeMode });
      setLabel('');
      setApiKey('');
      setApiSecret('');
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const activate = async (id: string) => {
    await api.saveSettings({ activeAccountId: id });
    await refreshAll();
  };

  const saveIps = async () => {
    await api.saveSettings({ allowedSignalIps: ips.split(',').map((s) => s.trim()).filter(Boolean) });
    await refreshAll();
  };

  return (
    <div className="page">
      <div className="card">
        <h3>Exchange accounts</h3>
        <table className="grid">
          <thead>
            <tr>
              <th>Label</th>
              <th>Exchange</th>
              <th>API key</th>
              <th>Futures mode</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {settings.accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.label} {a.id === settings.activeAccountId && <span className="pill on">active</span>}
                </td>
                <td>{a.exchange}</td>
                <td className="mono dim">{a.apiKey ? `${a.apiKey.slice(0, 6)}…` : a.exchange === 'paper' ? `$${a.paperBalanceUsd} simulated` : '—'}</td>
                <td>
                  <button
                    className="ghost"
                    title="One-way holds one net position per pair; hedge holds a long and a short simultaneously. Switch only with no open futures positions."
                    onClick={() => void api.updateAccount(a.id, { hedgeMode: !a.hedgeMode }).then(() => refreshAll())}
                  >
                    {a.hedgeMode ? 'Hedge (dual-side)' : 'One-way'} ⇄
                  </button>
                </td>
                <td>
                  {a.id !== settings.activeAccountId && (
                    <>
                      <button onClick={() => void activate(a.id)}>Use</button>{' '}
                      <button
                        className="ghost"
                        onClick={() => void api.deleteAccount(a.id).then(() => refreshAll())}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Add account</h3>
        <div className="row">
          <label>Label</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Binance main" />
          <label>Exchange</label>
          <select value={exchange} onChange={(e) => setExchange(e.target.value as 'binance' | 'paper')}>
            <option value="binance">Binance (API key)</option>
            <option value="paper">Paper trading</option>
          </select>
        </div>
        {exchange === 'binance' ? (
          <>
            <div className="row">
              <label>API key</label>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} style={{ width: 340 }} />
            </div>
            <div className="row">
              <label>API secret</label>
              <input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} style={{ width: 340 }} />
            </div>
            <p className="dim">
              Create the key in Binance with "Enable Reading" + "Enable Spot &amp; Margin Trading" and/or "Enable
              Futures". Never enable withdrawals. Keys are stored only in this server's local data file — restrict
              access to the machine running it.
            </p>
          </>
        ) : (
          <div className="row">
            <label>Start balance $</label>
            <input type="number" value={paperBalance} onChange={(e) => setPaperBalance(Number(e.target.value))} />
          </div>
        )}
        <div className="row">
          <label title="Hold a long and a short on the same pair at once (Binance dual-side position mode)">
            <input type="checkbox" checked={hedgeMode} onChange={(e) => setHedgeMode(e.target.checked)} /> Hedge mode
            (futures dual-side)
          </label>
        </div>
        <button className="primary" disabled={!label} onClick={() => void addAccount()}>
          Add account
        </button>
      </div>

      <div className="card">
        <h3>Signal sources</h3>
        <div className="row">
          <label>Allowed IPs</label>
          <input
            style={{ flex: 1 }}
            placeholder="empty = allow all · e.g. 52.89.214.238, 34.212.75.30, 54.218.53.128, 52.32.178.7 (TradingView)"
            value={ips}
            onChange={(e) => setIps(e.target.value)}
          />
          <button onClick={() => void saveIps()}>Save</button>
        </div>
        <p className="dim">
          Restrict webhook callers to TradingView's published alert IPs when the server is reachable from the
          internet. The per-hook secret is always checked as well.
        </p>
      </div>
    </div>
  );
}
