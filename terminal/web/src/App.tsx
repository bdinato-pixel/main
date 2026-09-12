import { useEffect, useState } from 'react';
import { connectWs } from './api';
import { useStore } from './store';
import { Chart } from './components/Chart';
import { TickerList } from './components/TickerList';
import { OrderPanel } from './components/OrderPanel';
import { BottomTabs } from './components/BottomTabs';
import { HooksPage } from './components/HooksPage';
import { SettingsPage } from './components/SettingsPage';

type Page = 'terminal' | 'hooks' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('terminal');
  const { market, setMarket, error, refreshAll, loadAccountState, loadSignals, setPrice } = useStore();

  useEffect(() => {
    void refreshAll();
    // Debounce 'changed' bursts into one refresh.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disconnect = connectWs((msg) => {
      if (msg.type === 'price') setPrice(msg.symbol, msg.price);
      if (msg.type === 'changed') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void loadAccountState();
          void loadSignals();
        }, 300);
      }
    });
    const poll = setInterval(() => void loadAccountState(), 15_000);
    return () => {
      disconnect();
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="header">
        <div className="logo">
          Trade<span>Hook</span>
        </div>
        <select value={market} onChange={(e) => setMarket(e.target.value as 'spot' | 'futures')}>
          <option value="futures">USDⓈ-M Futures</option>
          <option value="spot">Spot</option>
        </select>
        <nav>
          {(['terminal', 'hooks', 'settings'] as Page[]).map((p) => (
            <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <AccountBadge />
      </div>
      {error && <div className="error-bar">⚠ {error}</div>}
      {page === 'terminal' && (
        <div className="layout">
          <div className="panel panel-tickers">
            <TickerList />
          </div>
          <div className="panel panel-chart">
            <Chart />
          </div>
          <div className="panel panel-order">
            <OrderPanel />
          </div>
          <div className="panel panel-bottom">
            <BottomTabs />
          </div>
        </div>
      )}
      {page === 'hooks' && <HooksPage />}
      {page === 'settings' && <SettingsPage />}
    </>
  );
}

function AccountBadge() {
  const settings = useStore((s) => s.settings);
  const account = settings?.accounts.find((a) => a.id === settings.activeAccountId);
  if (!account) return null;
  return (
    <span className="dim">
      {account.label} {account.exchange === 'paper' && <span className="pill on">paper</span>}
      {account.hedgeMode && <span className="pill"> hedge</span>}
    </span>
  );
}
