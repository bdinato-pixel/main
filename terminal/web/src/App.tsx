import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { connectWs } from './api';
import { useStore } from './store';
import { Chart } from './components/Chart';
import { TickerList } from './components/TickerList';
import { OrderPanel } from './components/OrderPanel';
import { BottomTabs } from './components/BottomTabs';
import { HooksPage } from './components/HooksPage';
import { SettingsPage } from './components/SettingsPage';

type Page = 'terminal' | 'hooks' | 'settings';

/** True on phone-width screens; drives the stacked mobile layout. */
function useIsMobile(breakpoint = 760): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(`(max-width:${breakpoint}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${breakpoint}px)`);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [breakpoint]);
  return mobile;
}

export default function App() {
  const [page, setPage] = useState<Page>('terminal');
  const isMobile = useIsMobile();
  const { error, refreshAll, loadAccountState, loadSignals, setPrice } = useStore();

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
        <span className="market-label">USDⓈ-M Futures</span>
        <nav>
          {(['terminal', 'hooks', 'settings'] as Page[]).map((p) => (
            <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <span className="build-id" title={`Running build ${__BUILD_ID__}`}>
          {__BUILD_ID__}
        </span>
        <AccountBadge />
      </div>
      {error && <div className="error-bar">⚠ {error}</div>}
      {page === 'terminal' && (isMobile ? <MobileTerminal /> : <DesktopTerminal />)}
      {page === 'hooks' && <HooksPage />}
      {page === 'settings' && <SettingsPage />}
    </>
  );
}

function DesktopTerminal() {
  return (
    <PanelGroup direction="horizontal" className="layout" autoSaveId="th-cols" id="th-cols">
      <Panel defaultSize={16} minSize={10} className="panel panel-tickers" order={1}>
        <TickerList />
      </Panel>
      <PanelResizeHandle className="resize-h" />
      <Panel defaultSize={64} minSize={30} order={2}>
        <PanelGroup direction="vertical" autoSaveId="th-rows" id="th-rows">
          <Panel defaultSize={66} minSize={20} className="panel panel-chart" order={1}>
            <Chart />
          </Panel>
          <PanelResizeHandle className="resize-v" />
          <Panel defaultSize={34} minSize={12} className="panel panel-bottom" order={2}>
            <BottomTabs />
          </Panel>
        </PanelGroup>
      </Panel>
      <PanelResizeHandle className="resize-h" />
      <Panel defaultSize={20} minSize={12} className="panel panel-order" order={3}>
        <OrderPanel />
      </Panel>
    </PanelGroup>
  );
}

type MobileTab = 'markets' | 'chart' | 'trade' | 'positions';
const MOBILE_TABS: { id: MobileTab; label: string; icon: string }[] = [
  { id: 'markets', label: 'Markets', icon: '☰' },
  { id: 'chart', label: 'Chart', icon: '📈' },
  { id: 'trade', label: 'Trade', icon: '⇅' },
  { id: 'positions', label: 'Positions', icon: '≡' },
];

/** One full-width view at a time with a bottom tab bar (phone layout). */
function MobileTerminal() {
  const [tab, setTab] = useState<MobileTab>('chart');
  return (
    <div className="mobile-terminal">
      <div className="mobile-view">
        {tab === 'markets' && (
          <div className="panel panel-tickers">
            <TickerList onPick={() => setTab('chart')} />
          </div>
        )}
        {tab === 'chart' && (
          <div className="panel panel-chart">
            <Chart />
          </div>
        )}
        {tab === 'trade' && (
          <div className="panel panel-order">
            <OrderPanel />
          </div>
        )}
        {tab === 'positions' && (
          <div className="panel panel-bottom">
            <BottomTabs />
          </div>
        )}
      </div>
      <nav className="mobile-nav">
        {MOBILE_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <span className="mnav-icon">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function AccountBadge() {
  const settings = useStore((s) => s.settings);
  const account = settings?.accounts.find((a) => a.id === settings.activeAccountId);
  if (!account) return null;
  return (
    <span className="dim acct">
      {account.label} {account.exchange === 'paper' && <span className="pill on">paper</span>}
      {account.hedgeMode && <span className="pill"> hedge</span>}
    </span>
  );
}
