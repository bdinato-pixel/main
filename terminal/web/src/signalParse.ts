// Parse a free-text trading signal (e.g. a Discord/Telegram call) into fields
// the order panel can pre-fill. Deliberately tolerant: it reads labelled lines
// and pulls prices, so slightly different wordings still work. Never places an
// order itself — the user reviews the pre-filled form and submits.

export interface ParsedSignal {
  symbol?: string;
  side?: 'buy' | 'sell';
  /** Entry price(s); a DCA/average price becomes an extra entry leg. */
  entries: number[];
  /** Take-profit target price(s). */
  tps: number[];
  sl?: { price: number; trigger: 'price' | 'candle'; candleTf?: string };
  warnings: string[];
}

const CANDLE_TFS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w']);

function grab(line: string, re: RegExp): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/** Prices on a labelled line, most reliable form first: $-prefixed, then any
 *  decimal, then a bare integer. This avoids grabbing timeframes ("4H") or
 *  ratings ("6/10") while still reading "$0.2453", "0.2453" or "67000". */
function pricesOn(line: string): number[] {
  const dollar = grab(line, /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g);
  if (dollar.length) return dollar;
  const dec = grab(line, /(?<![a-zA-Z0-9])([0-9][0-9,]*\.[0-9]+)/g);
  if (dec.length) return dec;
  return grab(line, /(?<![a-zA-Z0-9.$])([0-9]{2,}(?:,[0-9]{3})*)(?![a-zA-Z0-9/.])/g);
}

/** Detect a candle-close SL trigger like "4H CLOSE BELOW" → tf "4h". */
function candleTf(line: string): string | undefined {
  const m = /([0-9]{1,2})\s*([mhdwMHDW])\b/.exec(line);
  if (!m || !/clos/i.test(line)) return undefined;
  const tf = `${m[1]}${m[2].toLowerCase()}`;
  return CANDLE_TFS.has(tf) ? tf : undefined;
}

export function parseSignal(text: string): ParsedSignal {
  const out: ParsedSignal = { entries: [], tps: [], warnings: [] };
  if (!text || !text.trim()) {
    out.warnings.push('Nothing to parse.');
    return out;
  }

  // Symbol + side, e.g. "$API3USDT LONG" or "API3 SHORT".
  const head = /\$?\s*([A-Za-z0-9]{2,20})\s+(LONG|SHORT|BUY|SELL)\b/i.exec(text);
  if (head) {
    let sym = head[1].toUpperCase();
    if (!/(USDT|USDC|BUSD)$/.test(sym)) sym += 'USDT';
    out.symbol = sym;
    const dir = head[2].toUpperCase();
    out.side = dir === 'LONG' || dir === 'BUY' ? 'buy' : 'sell';
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const low = line.toLowerCase();
    // Order matters: check SL/DCA/target before the generic "entry".
    if (/stop\s*loss|stoploss|\bsl\b/.test(low)) {
      const px = pricesOn(line);
      if (px.length) {
        const tf = candleTf(line);
        out.sl = { price: px[px.length - 1], trigger: tf ? 'candle' : 'price', candleTf: tf };
      }
    } else if (/\bdca\b|average|averaging|\badd\b/.test(low)) {
      out.entries.push(...pricesOn(line));
    } else if (/target|take\s*profit|\btps?\b/.test(low)) {
      out.tps.push(...pricesOn(line));
    } else if (/entry|buy\s*zone|limit/.test(low)) {
      out.entries.push(...pricesOn(line));
    }
  }

  // De-dupe and cap.
  out.entries = [...new Set(out.entries)].slice(0, 30);
  out.tps = [...new Set(out.tps)].slice(0, 20);

  if (!out.symbol) out.warnings.push('No symbol/side found — set them manually.');
  if (out.entries.length === 0) out.warnings.push('No entry price found — it will use a market order.');
  return out;
}
