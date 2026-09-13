import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantizeOrder, quantizeQty, quantizePrice, formatQty } from '../src/engine/quantizer.js';
import { computeBaseQty } from '../src/engine/amount.js';
import { planTpOrders, slPrice, updateTrailing } from '../src/engine/modules.js';
import { decide } from '../src/engine/decide.js';
import { parseSignal, normalizeSymbol, effectiveHook } from '../src/engine/signal.js';
import { defaultHookModules } from '../src/engine/defaults.js';
import type { Hook, ManagedPosition, Signal } from '../src/store/types.js';
import type { SymbolInfo } from '../src/exchange/types.js';

const INFO: SymbolInfo = {
  symbol: 'TESTUSDT',
  base: 'TEST',
  quote: 'USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
};

function makeHook(patch: Partial<Hook> = {}): Hook {
  return {
    id: 'h1',
    name: 'Hook 1',
    secret: 's3cret',
    enabled: true,
    accountId: 'paper',
    market: 'futures',
    fixedSymbol: '',
    signalControlled: [],
    createdAt: 0,
    ...defaultHookModules(),
    ...patch,
  };
}

function makeSignal(patch: Partial<Signal> = {}): Signal {
  return { name: 'Hook 1', secret: 's3cret', side: 'buy', symbol: 'TESTUSDT', raw: {}, ...patch };
}

function makePosition(side: 'long' | 'short', patch: Partial<ManagedPosition> = {}): ManagedPosition {
  return {
    id: 'p1',
    accountId: 'paper',
    market: 'futures',
    symbol: 'TESTUSDT',
    side,
    qty: 10,
    entryPrice: 100,
    leverage: 5,
    marginMode: 'cross',
    openedAt: 0,
    status: 'open',
    realizedPnl: 0,
    dcaCount: 0,
    tpOrderIds: [],
    tpFilledCount: 0,
    config: { tp: defaultHookModules().tp, sl: defaultHookModules().sl, slx: defaultHookModules().slx },
    ...patch,
  };
}

// ---------------------------------------------------------------- quantizer

test('quantizes qty and price to filter steps', () => {
  assert.equal(quantizeQty(INFO, 1.23456), 1.234);
  assert.equal(quantizePrice(INFO, 99.999), 99.99);
  assert.equal(formatQty(INFO, 0.1 / 0.001 * 0.001), '0.100');
});

test('rejects orders below minQty / minNotional', () => {
  assert.equal(quantizeOrder(INFO, 0.0004, 100), null);
  assert.equal(quantizeOrder(INFO, 0.04, 100), null); // 0.04*100 = 4 < 5 notional
  assert.deepEqual(quantizeOrder(INFO, 0.06, 100), { qty: 0.06, price: 100 });
});

// ------------------------------------------------------------ amount modes

test('amount modes resolve to base quantities', () => {
  const ctx = {
    price: 100,
    leverage: 5,
    freeBalance: 400,
    fullBalance: 3100,
    positionQty: 10,
    positionEntryPrice: 90,
  };
  assert.equal(computeBaseQty({ mode: 'amount', value: 7 }, ctx), 7);
  assert.equal(computeBaseQty({ mode: 'volume_usd', value: 100 }, ctx), 1);
  assert.equal(computeBaseQty({ mode: 'full_balance_pct', value: 10 }, ctx), 3.1);
  assert.equal(computeBaseQty({ mode: 'full_balance_pct_lev', value: 10 }, ctx), 15.5);
  assert.equal(computeBaseQty({ mode: 'free_balance_pct', value: 10 }, ctx), 0.4);
  assert.equal(computeBaseQty({ mode: 'free_balance_pct_lev', value: 10 }, ctx), 2);
  assert.equal(computeBaseQty({ mode: 'position_amount_pct', value: 50 }, ctx), 5);
  assert.equal(computeBaseQty({ mode: 'position_volume_pct', value: 50 }, ctx), 4.5); // 10*90*0.5/100
});

// ---------------------------------------------------------------- TP plans

test('plans a TP grid with offsets and even piece distribution', () => {
  const tp = {
    enabled: true,
    orderType: 'limit' as const,
    orders: [
      { ofsPct: 1, price: 0, piecePct: 30 },
      { ofsPct: 2, price: 0, piecePct: 30 },
      { ofsPct: 3, price: 0, piecePct: 40 },
    ],
    reorderLevels: true,
    updateBySignal: false,
  };
  const plan = planTpOrders(tp, 'long', 100, 10, INFO);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((o) => o.price), [101, 102, 103]);
  assert.deepEqual(plan.map((o) => o.qty), [3, 3, 4]);
  // Short mirrors below entry.
  const planShort = planTpOrders(tp, 'short', 100, 10, INFO);
  assert.deepEqual(planShort.map((o) => o.price), [99, 98, 97]);
});

test('TP absolute price overrides the offset % on a level', () => {
  const tp = {
    enabled: true,
    orderType: 'limit' as const,
    orders: [
      { ofsPct: 1, price: 105, piecePct: 50 }, // absolute wins
      { ofsPct: 2, price: 0, piecePct: 50 }, // % used
    ],
    reorderLevels: true,
    updateBySignal: false,
  };
  const plan = planTpOrders(tp, 'long', 100, 10, INFO);
  assert.deepEqual(plan.map((o) => o.price), [105, 102]);
});

test('TP last level absorbs rounding remainder; sum equals position', () => {
  const tp = {
    enabled: true,
    orderType: 'limit' as const,
    orders: [
      { ofsPct: 1, price: 0, piecePct: 33.3 },
      { ofsPct: 2, price: 0, piecePct: 33.3 },
      { ofsPct: 3, price: 0, piecePct: 33.4 },
    ],
    reorderLevels: true,
    updateBySignal: false,
  };
  const plan = planTpOrders(tp, 'long', 100, 1, INFO);
  const total = plan.reduce((s, o) => s + o.qty, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sum ${total} != 1`);
});

// -------------------------------------------------------------------- SL

test('SL price from % offset and from absolute price', () => {
  const sl = { enabled: true, ofsPct: 5, price: 0, orderType: 'stop_market' as const, reorderAfterDca: true };
  assert.equal(slPrice(sl, 'long', 100), 95);
  assert.equal(slPrice(sl, 'short', 100), 105);
  assert.equal(slPrice({ ...sl, price: 91 }, 'long', 100), 91);
});

// -------------------------------------------------------------- trailing

test('trailing stop arms, trails and triggers', () => {
  const slx = { enabled: true, activationOfsPct: 1, trailPct: 0.5 };
  // Not armed below activation.
  let s = updateTrailing(slx, 'long', 100, undefined, 100.5);
  assert.equal(s.armed, false);
  // Arms at +1%.
  s = updateTrailing(slx, 'long', 100, s, 101);
  assert.equal(s.armed, true);
  assert.ok(Math.abs(s.stopPrice - 101 * 0.995) < 1e-9);
  assert.equal(s.triggered, false);
  // Trails up.
  s = updateTrailing(slx, 'long', 100, s, 103);
  assert.ok(Math.abs(s.stopPrice - 103 * 0.995) < 1e-9);
  // Small pullback: no trigger.
  s = updateTrailing(slx, 'long', 100, s, 102.9);
  assert.equal(s.triggered, false);
  // Pullback through the stop triggers.
  s = updateTrailing(slx, 'long', 100, s, 102.4);
  assert.equal(s.triggered, true);
  // Short side mirrors.
  let sh = updateTrailing(slx, 'short', 100, undefined, 99);
  assert.equal(sh.armed, true);
  sh = updateTrailing(slx, 'short', 100, sh, 97);
  sh = updateTrailing(slx, 'short', 100, sh, 97.6);
  assert.equal(sh.triggered, true);
});

// ------------------------------------------------------------- decisions

test('decision table: Both mode (Finandy signal processing logic)', () => {
  const hook = makeHook({ dca: { ...defaultHookModules().dca, enabled: true } });
  // No position + buy → open long.
  assert.equal(decide(hook, makeSignal({ side: 'buy' }), undefined).action, 'open');
  assert.equal(decide(hook, makeSignal({ side: 'buy' }), undefined).dir, 'long');
  // No position + sell → open short.
  assert.equal(decide(hook, makeSignal({ side: 'sell' }), undefined).dir, 'short');
  // Long + buy → DCA.
  assert.equal(decide(hook, makeSignal({ side: 'buy' }), makePosition('long')).action, 'dca');
  // Long + sell → close.
  assert.equal(decide(hook, makeSignal({ side: 'sell' }), makePosition('long')).action, 'close');
  // Short + buy → close; with reverse enabled → reverse.
  assert.equal(decide(hook, makeSignal({ side: 'buy' }), makePosition('short')).action, 'close');
  const revHook = makeHook({ close: { ...defaultHookModules().close, reverse: true } });
  assert.equal(decide(revHook, makeSignal({ side: 'buy' }), makePosition('short')).action, 'reverse');
});

test('decision table: DCA disabled ignores same-side signals', () => {
  const hook = makeHook(); // dca disabled by default
  assert.equal(decide(hook, makeSignal({ side: 'buy' }), makePosition('long')).action, 'ignore');
});

test('decision table: long-only / short-only', () => {
  const longOnly = makeHook({ open: { ...defaultHookModules().open, positionMode: 'long_only' } });
  assert.equal(decide(longOnly, makeSignal({ side: 'sell' }), undefined).action, 'ignore');
  assert.equal(decide(longOnly, makeSignal({ side: 'buy' }), undefined).action, 'open');
  // Sell still closes an open long.
  assert.equal(decide(longOnly, makeSignal({ side: 'sell' }), makePosition('long')).action, 'close');
  const shortOnly = makeHook({ open: { ...defaultHookModules().open, positionMode: 'short_only' } });
  assert.equal(decide(shortOnly, makeSignal({ side: 'buy' }), undefined).action, 'ignore');
  assert.equal(decide(shortOnly, makeSignal({ side: 'sell' }), undefined).action, 'open');
});

test('decision table: strategy mode uses positionSide', () => {
  const hook = makeHook({
    open: { ...defaultHookModules().open, positionMode: 'strategy' },
    dca: { ...defaultHookModules().dca, enabled: true },
    close: { ...defaultHookModules().close, reverse: true },
  });
  // Entry.
  assert.equal(decide(hook, makeSignal({ side: 'buy', positionSide: 'long' }), undefined).action, 'open');
  // Exit to flat.
  assert.equal(decide(hook, makeSignal({ side: 'sell', positionSide: 'flat' }), makePosition('long')).action, 'close');
  // Reversal long → short.
  assert.equal(decide(hook, makeSignal({ side: 'sell', positionSide: 'short' }), makePosition('long')).action, 'reverse');
  // Add to long.
  assert.equal(decide(hook, makeSignal({ side: 'buy', positionSide: 'long' }), makePosition('long')).action, 'dca');
  // No positionSide → ignored in strategy mode.
  assert.equal(decide(hook, makeSignal({ side: 'buy' }), undefined).action, 'ignore');
});

test('positionSide flat closes even outside strategy mode', () => {
  const hook = makeHook();
  assert.equal(decide(hook, makeSignal({ side: 'buy', positionSide: 'flat' }), makePosition('short')).action, 'close');
  assert.equal(decide(hook, makeSignal({ side: 'buy', positionSide: 'flat' }), undefined).action, 'ignore');
});

test('TP update signal routes to update_tp', () => {
  const hook = makeHook({ tp: { ...defaultHookModules().tp, updateBySignal: true } });
  const signal = makeSignal({ tp: { orders: [{ price: '101' }], update: true } });
  assert.equal(decide(hook, signal, makePosition('long')).action, 'update_tp');
  // Without updateBySignal → ignore.
  assert.equal(decide(makeHook(), signal, makePosition('long')).action, 'ignore');
});

// ------------------------------------------------------------- signal parse

test('parses a Finandy-style message and normalizes symbols', () => {
  const s = parseSignal({
    name: 'Hook 123',
    secret: '234',
    side: 'buy',
    symbol: 'BINANCE:XRPUSDT.P',
    positionSide: 'Long',
    tp: { orders: [{ ofs: '2', price: '', piece: '33.3' }], update: true },
  });
  assert.equal(s.symbol, 'XRPUSDT');
  assert.equal(s.positionSide, 'long');
  assert.equal(s.tp?.update, true);
  assert.equal(normalizeSymbol('btcusdt'), 'BTCUSDT');
});

test('rejects malformed messages', () => {
  assert.throws(() => parseSignal({ secret: 'x', side: 'hold', symbol: 'BTCUSDT' }));
  assert.throws(() => parseSignal('not json object'));
});

test('signal-controlled options override hook settings', () => {
  const hook = makeHook({ signalControlled: ['open.amount', 'sl.ofs'] });
  const signal = makeSignal({ open: { amount: 500 }, sl: { ofs: '2.5' } });
  const h = effectiveHook(hook, signal);
  assert.equal(h.open.amount.value, 500);
  assert.equal(h.sl.ofsPct, 2.5);
  // Not marked controlled → keeps terminal settings.
  const h2 = effectiveHook(makeHook(), signal);
  assert.equal(h2.open.amount.value, 50);
  assert.equal(h2.sl.ofsPct, 5);
});
