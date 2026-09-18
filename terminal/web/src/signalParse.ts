// Parse a free-text trading signal (e.g. a Discord/Telegram call) into fields
// the order panel can pre-fill. Deliberately tolerant: it splits the text into
// clauses and reads each labelled directive, so different wordings/emojis and
// several directives packed onto one line still parse. Never places an order
// itself — the user reviews the pre-filled form and submits.

export interface ParsedSignal {
  symbol?: string;
  side?: 'buy' | 'sell';
  leverage?: number;
  marginMode?: 'cross' | 'isolated';
  /** Explicit entry price(s). */
  entries: number[];
  /** DCA / averaging price(s) — separate so they don't get read as the entry. */
  dca: number[];
  /** True when the call says enter at market/CMP with no explicit entry price. */
  marketEntry: boolean;
  /** Take-profit target price(s). */
  tps: number[];
  sl?: { price: number; trigger: 'price' | 'candle'; candleTf?: string };
  warnings: string[];
}

const CANDLE_TFS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w']);

const NOT_TICKERS = new Set([
  'LONG', 'SHORT', 'BUY', 'SELL', 'CMP', 'TP', 'TPS', 'SL', 'DCA', 'USDT', 'USDC', 'BUSD', 'NEW', 'POSITION',
  'TARGET', 'TARGETS', 'ENTRY', 'ENTRIES', 'STOP', 'LOSS', 'CROSS', 'ISOLATED', 'LEVERAGE', 'LEV', 'NOTES',
  'NOTE', 'RATING', 'COIN', 'PAIR', 'SYMBOL', 'TICKER', 'SWING', 'SCALP', 'HTF', 'LTF', 'ATH', 'CLOSE',
  'ABOVE', 'BELOW', 'UNDER', 'MARGIN', 'AND', 'THE', 'FOR', 'CANDLE', 'DAY', 'WEEK', 'HOUR',
]);

function grab(line: string, re: RegExp): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/** Prices in a clause, most reliable form first: $-prefixed, then any decimal,
 *  then a bare integer. Percentage values ("0.5%") are skipped (sizing notes). */
function pricesOn(line: string): number[] {
  const dollar = grab(line, /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?!\s*%)/g);
  if (dollar.length) return dollar;
  const dec = grab(line, /(?<![a-zA-Z0-9])([0-9][0-9,]*\.[0-9]+)(?!\s*%)/g);
  if (dec.length) return dec;
  return grab(line, /(?<![a-zA-Z0-9.$])([0-9]{2,}(?:,[0-9]{3})*)(?!\s*%)(?![a-zA-Z0-9/.])/g);
}

/** Candle-close SL trigger: "4H close", "1 day candle close below", "daily close". */
function candleTf(line: string): string | undefined {
  if (!/clos/i.test(line)) return undefined;
  const m = /(\d{1,2})\s*(days|day|d|weeks|week|w|hours|hour|hrs|hr|h|minutes|minute|mins|min|m)\b/i.exec(line);
  if (m) {
    const tf = `${m[1]}${m[2][0].toLowerCase()}`;
    if (CANDLE_TFS.has(tf)) return tf;
  }
  if (/\bdaily\b/i.test(line)) return '1d';
  if (/\bweekly\b/i.test(line)) return '1w';
  if (/\bhourly\b/i.test(line)) return '1h';
  return undefined;
}

function detectSide(text: string): 'buy' | 'sell' | undefined {
  const m = /\b(long|short|buy|sell)\b/i.exec(text);
  if (!m) return undefined;
  const w = m[1].toLowerCase();
  return w === 'long' || w === 'buy' ? 'buy' : 'sell';
}

function detectSymbol(text: string): string | undefined {
  let raw: string | undefined;
  const dollar = /\$([A-Za-z0-9]{2,20})/.exec(text);
  const labeled = /(?:coin|pair|symbol|ticker)\s*[:\-]?\s*\$?([A-Za-z0-9]{2,20})/i.exec(text);
  if (dollar) raw = dollar[1];
  else if (labeled) raw = labeled[1];
  else {
    const re = /\b([A-Z][A-Z0-9]{1,11})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!NOT_TICKERS.has(m[1])) {
        raw = m[1];
        break;
      }
    }
  }
  if (!raw) return undefined;
  let sym = raw.toUpperCase();
  if (!/(USDT|USDC|BUSD)$/.test(sym)) sym += 'USDT';
  return sym;
}

function detectLeverage(text: string): number | undefined {
  const m =
    /(\d{1,3})\s*x\b/i.exec(text) ||
    /(\d{1,3})\s*(?:leverage|lev)\b/i.exec(text) ||
    /(?:leverage|lev)\s*[:\-]?\s*(\d{1,3})/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= 125 ? n : undefined;
}

export function parseSignal(text: string): ParsedSignal {
  const out: ParsedSignal = { entries: [], dca: [], marketEntry: false, tps: [], warnings: [] };
  if (!text || !text.trim()) {
    out.warnings.push('Nothing to parse.');
    return out;
  }

  out.symbol = detectSymbol(text);
  out.side = detectSide(text);
  out.leverage = detectLeverage(text);
  if (/\bisolated\b/i.test(text)) out.marginMode = 'isolated';
  else if (/\bcross\b/i.test(text)) out.marginMode = 'cross';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\bnotes?\b|reasoning|disclaimer|not financial/i.test(line)) continue;
    // Split into clauses so several directives on one line don't collide.
    // Split on commas/semicolons and on a sentence period only (lookahead for
    // whitespace/end), so decimals like "510.39" stay intact.
    for (const seg of line.split(/[,;]+|\.(?=\s|$)/)) {
      const s = seg.trim();
      if (!s) continue;
      const low = s.toLowerCase();
      // Order matters: SL/DCA/target before the generic "entry".
      if (/\bstop|stoploss|\bsl\b|invalidat/.test(low)) {
        const px = pricesOn(s);
        if (px.length) {
          const tf = candleTf(s);
          out.sl = { price: px[px.length - 1], trigger: tf ? 'candle' : 'price', candleTf: tf };
        }
      } else if (/\bdca\b|averag/.test(low)) {
        out.dca.push(...pricesOn(s));
      } else if (/target|take\s*profit|\btps?\b/.test(low)) {
        out.tps.push(...pricesOn(s));
      } else if (/entry|entries|buy\s*zone|\blimit\b/.test(low)) {
        out.entries.push(...pricesOn(s));
      }
    }
  }

  out.entries = [...new Set(out.entries)].slice(0, 30);
  out.dca = [...new Set(out.dca)].slice(0, 30);
  out.tps = [...new Set(out.tps)].slice(0, 20);
  out.marketEntry = out.entries.length === 0 && /\bcmp\b|market\s*price|at\s*market|\bmarket\b/i.test(text);

  if (!out.symbol) out.warnings.push('No symbol found — set it manually.');
  if (!out.side) out.warnings.push('No side found — set Buy/Sell manually.');
  if (out.entries.length === 0 && out.dca.length === 0 && !out.marketEntry) {
    out.warnings.push('No entry price — it will use a market order.');
  }
  if (out.marketEntry) {
    out.warnings.push(`Entry is at market (CMP)${out.dca.length ? ' — seeded as a grid with the DCA leg.' : '.'}`);
  }
  if (out.tps.length === 0) out.warnings.push('No take-profits found — add them (some calls show TPs only on the chart).');
  return out;
}
