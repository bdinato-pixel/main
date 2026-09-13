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
import type { Kline } from '../types';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

/** Decimal places implied by a tick size (0.0001 → 4, 0.00025 → 5, 5 → 0). */
function decimalsFromTick(tick: number | undefined): number {
  if (!tick || tick <= 0) return 2;
  const [mantissa, exp] = tick.toExponential().split('e');
  const mantissaDecimals = (mantissa.split('.')[1] ?? '').length;
  return Math.min(8, Math.max(0, -Number(exp) + mantissaDecimals));
}

type Bar = { time: number; open: number; high: number; low: number; close: number };

export function Chart() {
  const { symbol, interval, market, setInterval: setIv } = useStore();
  const account = useStore((s) => s.account());
  const price = useStore((s) => s.prices[symbol]);
  const info = useStore((s) => s.symbols.find((x) => x.symbol === symbol));
  const managed = useStore((s) => s.managed.find((p) => p.symbol === symbol && p.market === market));

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const lastBarRef = useRef<Bar | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { color: '#0d1117' }, textColor: '#7d8590' },
      grid: { vertLines: { color: '#161c26' }, horzLines: { color: '#161c26' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, borderColor: '#232b36' },
      rightPriceScale: { borderColor: '#232b36' },
      // Pin a valid BCP-47 locale: some environments report an invalid
      // system locale (e.g. "en-US@posix") that makes Intl/date formatting
      // throw and leaves the chart blank.
      localization: { locale: 'en-US' },
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

  // Match the price-scale precision to the symbol's tick size, otherwise
  // sub-cent coins (e.g. 1000BONK ~0.00278) round to 0.00 on the axis.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const decimals = decimalsFromTick(info?.tickSize);
    series.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: info?.tickSize || 1 / 10 ** decimals },
    });
  }, [info?.tickSize, symbol]);

  // Load candles when symbol/interval/market changes, and subscribe the pair
  // to the live price stream so the header/last candle track in realtime.
  useEffect(() => {
    let cancelled = false;
    void api.watch(account, market, symbol).catch(() => {});
    const load = () =>
      api
        .klines(account, market, symbol, interval)
        .then((klines) => {
          if (cancelled || !seriesRef.current) return;
          const bars: Bar[] = klines.map((k: Kline) => ({
            time: k.openTime / 1000,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
          }));
          seriesRef.current.setData(bars as never);
          lastBarRef.current = bars.length ? { ...bars[bars.length - 1] } : null;
        })
        .catch(() => {});
    void load().then(() => chartRef.current?.timeScale().fitContent());
    const reload = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(reload);
    };
  }, [symbol, interval, market, account]);

  // Live tick: extend the last candle (close, and high/low envelope).
  useEffect(() => {
    const series = seriesRef.current;
    const bar = lastBarRef.current;
    if (!series || !bar || !price || price <= 0) return;
    const updated: Bar = {
      ...bar,
      close: price,
      high: Math.max(bar.high, price),
      low: Math.min(bar.low, price),
    };
    lastBarRef.current = updated;
    series.update(updated as never);
  }, [price]);

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

  const priceDecimals = decimalsFromTick(info?.tickSize);

  return (
    <>
      <div className="chart-toolbar">
        <strong>{symbol}</strong>
        <span className="price">
          {price ? price.toLocaleString(undefined, { maximumFractionDigits: Math.max(priceDecimals, 2) }) : '—'}
        </span>
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
