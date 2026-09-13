import { useMemo, useState } from 'react';
import { useStore } from '../store';

export function TickerList({ onPick }: { onPick?: () => void } = {}) {
  const { tickers, symbols, symbol, setSymbol, prices } = useStore();
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.toUpperCase();
    // Only show pairs the terminal can actually trade (present in the exchange's
    // tradable-symbols set). Some non-perpetual listings leak into the 24h
    // ticker feed but have no order metadata — selecting them is a dead end.
    const tradable = new Set(symbols.map((s) => s.symbol));
    const filterTradable = tradable.size > 0;
    return tickers
      .filter((t) => t.symbol.endsWith('USDT') && (!filterTradable || tradable.has(t.symbol)) && (!q || t.symbol.includes(q)))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 120);
  }, [tickers, symbols, query]);

  return (
    <>
      <div className="ticker-search">
        <input placeholder="Search pair…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Pair</th>
            <th className="num">Last</th>
            <th className="num">24h %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr
              key={t.symbol}
              onClick={() => {
                setSymbol(t.symbol);
                onPick?.();
              }}
              style={{ cursor: 'pointer', background: t.symbol === symbol ? 'rgba(79,140,201,0.12)' : undefined }}
            >
              <td>{t.symbol.replace('USDT', '')}<span className="dim">/USDT</span></td>
              <td className="num mono">{(prices[t.symbol] ?? t.last).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
              <td className={`num ${t.changePct >= 0 ? 'pos' : 'neg'}`}>{t.changePct.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
