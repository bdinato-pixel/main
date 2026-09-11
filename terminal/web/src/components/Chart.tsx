import { useEffect, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  LineStyle,
} from 'lightweight-charts';
import { api } from '../api';
import { useStore } from '../store';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function Chart() {
  const { symbol, interval, market, setInterval: setIv } = useStore();
  const account = useStore((s) => s.account());
  const price = useStore((s) => s.prices[symbol]);
  const managed = useStore((s) => s.managed.find((p) => p.symbol === symbol && p.market === market));

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { color: '#0d1117' }, textColor: '#7d8590' },
      grid: { vertLines: { color: '#161c26' }, horzLines: { color: '#161c26' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, borderColor: '#232b36' },
      rightPriceScale: { borderColor: '#232b36' },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Load candles when symbol/interval/market changes.
  useEffect(() => {
    let cancelled = false;
    void api
      .klines(account, market, symbol, interval)
      .then((klines) => {
        if (cancelled || !seriesRef.current) return;
        seriesRef.current.setData(
          klines.map((k) => ({
            time: (k.openTime / 1000) as never,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
          })),
        );
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {});
    const reload = setInterval(() => {
      void api
        .klines(account, market, symbol, interval)
        .then((klines) => {
          if (cancelled || !seriesRef.current) return;
          seriesRef.current.setData(
            klines.map((k) => ({
              time: (k.openTime / 1000) as never,
              open: k.open,
              high: k.high,
              low: k.low,
              close: k.close,
            })),
          );
        })
        .catch(() => {});
    }, 20_000);
    return () => {
      cancelled = true;
      clearInterval(reload);
    };
  }, [symbol, interval, market, account]);

  // Overlay entry/TP/SL lines for the managed position on this pair.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];
    if (!managed) return;
    const mk = (value: number, color: string, title: string) =>
      linesRef.current.push(
        series.createPriceLine({ price: value, color, title, lineWidth: 1, lineStyle: LineStyle.Dashed }),
      );
    mk(managed.entryPrice, '#4f8cc9', `entry ${managed.side}`);
    const sl = managed.slPrice ?? managed.virtualSlPrice;
    if (sl) mk(sl, '#ef5350', 'SL');
    if (managed.trailing?.armed) mk(managed.trailing.stopPrice, '#e2b93d', 'trail');
    for (const [i, lvl] of (managed.tpLevels ?? []).entries()) mk(lvl.price, '#26a69a', `TP${i + 1}`);
  }, [managed]);

  return (
    <>
      <div className="chart-toolbar">
        <strong>{symbol}</strong>
        <span className="price">{price ? price.toLocaleString(undefined, { maximumFractionDigits: 8 }) : '—'}</span>
        <div className="spacer" style={{ flex: 1 }} />
        {INTERVALS.map((iv) => (
          <button key={iv} className={iv === interval ? 'primary' : 'ghost'} onClick={() => setIv(iv)}>
            {iv}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="chart-container" />
    </>
  );
}
