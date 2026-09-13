import { test } from 'node:test';
import assert from 'node:assert/strict';
// Pure UI-side parser (no DOM); imported directly for coverage.
import { parseSignal } from '../../web/src/signalParse.ts';

test('parses a Discord-style call (symbol, side, entry+DCA, TP, candle SL)', () => {
  const text = [
    '$API3USDT LONG',
    'Entry: LIMIT PRICE ($0.2453)',
    'Stoploss: 4H CLOSE BELOW $0.2259',
    'DCA: $0.2318',
    'TARGET: $0.3547',
    'RATING: 6/10',
    'REASONING: TRADING THE FIRST RETEST AFTER THE BREAKOUT',
  ].join('\n');

  const p = parseSignal(text);
  assert.equal(p.symbol, 'API3USDT');
  assert.equal(p.side, 'buy');
  assert.deepEqual(p.entries, [0.2453, 0.2318]); // entry + DCA leg
  assert.deepEqual(p.tps, [0.3547]);
  assert.ok(p.sl);
  assert.equal(p.sl.price, 0.2259);
  assert.equal(p.sl.trigger, 'candle');
  assert.equal(p.sl.candleTf, '4h');
  assert.equal(p.warnings.length, 0);
});

test('rating and reasoning numbers are not mistaken for prices', () => {
  const p = parseSignal('$ETHUSDT SHORT\nEntry: $2500\nTP: $2300\nSL: $2600\nRATING: 7/10');
  assert.equal(p.symbol, 'ETHUSDT');
  assert.equal(p.side, 'sell');
  assert.deepEqual(p.entries, [2500]);
  assert.deepEqual(p.tps, [2300]);
  assert.equal(p.sl?.price, 2600);
  assert.equal(p.sl?.trigger, 'price');
});

test('bare symbol gets USDT appended; touch SL by default', () => {
  const p = parseSignal('SOL LONG\nentry 0.0 buy zone 145.5\ntarget 160\nstop loss 138');
  assert.equal(p.symbol, 'SOLUSDT');
  assert.equal(p.side, 'buy');
  assert.ok(p.entries.includes(145.5));
  assert.deepEqual(p.tps, [160]);
  assert.equal(p.sl?.price, 138);
  assert.equal(p.sl?.trigger, 'price');
});

test('parses an emoji/labelled call with leverage, multi-target and 1-day candle SL (Belovy)', () => {
  const text = [
    '🧪 New position',
    '🪙 Coin: ENA LONG (20 leverage cross)',
    '📋 Entries: 0.14165 cmp',
    '🎯 Target 1: 0.145',
    '🎯 Target 2: 0.15',
    '🎯 Target 3: 0.156',
    '🎯 Target 4: 0.165',
    '🎯 Target 5: 0.173',
    '🎯 Target 6: 0.18',
    '🔴 Stop loss: 1 day candle close below 0.135',
    'DCA: 0.136 (1% of margin)',
    '📝 Notes: Swing trade. leave space to DCA 🔒 0.5% for entry, 1% for DCA @Crypto',
  ].join('\n');

  const p = parseSignal(text);
  assert.equal(p.symbol, 'ENAUSDT');
  assert.equal(p.side, 'buy');
  assert.equal(p.leverage, 20);
  assert.equal(p.marginMode, 'cross');
  assert.deepEqual(p.entries, [0.14165, 0.136]); // entry + DCA leg, not the 0.5%/1% notes
  assert.deepEqual(p.tps, [0.145, 0.15, 0.156, 0.165, 0.173, 0.18]);
  assert.equal(p.sl?.price, 0.135);
  assert.equal(p.sl?.trigger, 'candle');
  assert.equal(p.sl?.candleTf, '1d');
});

test('parses a prose call with side-before-ticker, CMP entry and 1H-close stop; TPs on chart (Trader Neil)', () => {
  const text =
    'Going long INIT again at CMP. TPs above, 1H close under 0.0646 for stops.\n' +
    'Send it higher. Still looks great and will keep longing as long as it does';
  const p = parseSignal(text);
  assert.equal(p.symbol, 'INITUSDT');
  assert.equal(p.side, 'buy');
  assert.equal(p.entries.length, 0); // "at CMP" → market entry
  assert.equal(p.sl?.price, 0.0646);
  assert.equal(p.sl?.trigger, 'candle');
  assert.equal(p.sl?.candleTf, '1h');
  assert.ok(p.warnings.some((w) => /take-profit/i.test(w))); // TPs were only on the chart
});

test('empty / junk input yields warnings, no throw', () => {
  const p = parseSignal('good luck everyone');
  assert.equal(p.symbol, undefined);
  assert.equal(p.entries.length, 0);
  assert.ok(p.warnings.length > 0);
});
