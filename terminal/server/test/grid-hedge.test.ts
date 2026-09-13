import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db.js';
import { TradingEngine } from '../src/engine/engine.js';
import { ManualPriceSource, PaperAdapter } from '../src/exchange/paper.js';
import { defaultGridConfig, defaultHookModules } from '../src/engine/defaults.js';
import { planGrid } from '../src/engine/modules.js';
import { decide } from '../src/engine/decide.js';
import type { Hook, ManagedPosition, Signal } from '../src/store/types.js';
import type { SymbolInfo } from '../src/exchange/types.js';

const INFO: SymbolInfo = {
  symbol: 'GRDUSDT',
  base: 'GRD',
  quote: 'USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
};

const SYMBOLS: SymbolInfo[] = [INFO, { ...INFO, symbol: 'HEDUSDT', base: 'HED' }];

function makeEnv(hedge = false) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-gh-'));
  const db = new Db(join(dir, 'db.json'));
  db.settings.accounts[0].hedgeMode = hedge;
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new PaperAdapter('futures', 'paper', source, 10_000);
  const engine = new TradingEngine(db, async () => adapter);
  return { db, source, adapter, engine };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------- planGrid

test('planGrid: even split between first and last offsets (long below price)', () => {
  const plan = planGrid({ count: 4, firstOfsPct: 1, lastOfsPct: 4, qtyFactor: 1, density: 1 }, 'long', 100, 4, INFO);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map((o) => o.price), [99, 98, 97, 96]);
  assert.deepEqual(plan.map((o) => o.qty), [1, 1, 1, 1]);
});

test('planGrid: qtyFactor scales successive orders; short grids sit above price', () => {
  const plan = planGrid({ count: 3, firstOfsPct: 1, lastOfsPct: 3, qtyFactor: 2, density: 1 }, 'short', 100, 7, INFO);
  assert.deepEqual(plan.map((o) => o.price), [101, 102, 103]);
  assert.deepEqual(plan.map((o) => o.qty), [1, 2, 4]); // weights 1:2:4 of 7
});

test('planGrid: absolute price mode interpolates between first/last prices', () => {
  const plan = planGrid(
    { count: 4, priceMode: 'price', firstPrice: 99, lastPrice: 96, firstOfsPct: 0, lastOfsPct: 0, qtyFactor: 1, density: 1 },
    'long',
    100,
    4,
    INFO,
  );
  // Even interpolation 99 → 96 across 4 orders, ignoring % offsets and ref.
  assert.deepEqual(plan.map((o) => o.price), [99, 98, 97, 96]);
  assert.deepEqual(plan.map((o) => o.qty), [1, 1, 1, 1]);
  // Works without a reference price (limit grid set purely by price).
  const noRef = planGrid(
    { count: 3, priceMode: 'price', firstPrice: 101, lastPrice: 103, firstOfsPct: 0, lastOfsPct: 0, qtyFactor: 1, density: 1 },
    'short',
    0,
    3,
    INFO,
  );
  assert.deepEqual(noRef.map((o) => o.price), [101, 102, 103]);
  // Falls back to offset mode when absolute prices are missing.
  const fallback = planGrid(
    { count: 2, priceMode: 'price', firstPrice: 0, lastPrice: 0, firstOfsPct: 1, lastOfsPct: 2, qtyFactor: 1, density: 1 },
    'long',
    100,
    2,
    INFO,
  );
  assert.deepEqual(fallback.map((o) => o.price), [99, 98]);
});

test('planGrid: density shifts spacing; sub-minimum orders are dropped', () => {
  const dense = planGrid({ count: 3, firstOfsPct: 0, lastOfsPct: 4, qtyFactor: 1, density: 2 }, 'long', 100, 3, INFO);
  // density 2 → offsets 0, 4*(0.5)^2 = 1, 4 → prices 100, 99, 96
  assert.deepEqual(dense.map((o) => o.price), [100, 99, 96]);
  // Tiny total: each level 0.016 → 0.016*~100 < minNotional 5 → all dropped.
  const dropped = planGrid({ count: 3, firstOfsPct: 1, lastOfsPct: 3, qtyFactor: 1, density: 1 }, 'long', 100, 0.05, INFO);
  assert.equal(dropped.length, 0);
});

// ------------------------------------------------------- hedge decide table

function makeHook(patch: Partial<Hook> = {}): Hook {
  return {
    id: 'h1',
    name: 'H',
    secret: 's',
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
  return { name: 'H', secret: 's', side: 'buy', symbol: 'HEDUSDT', raw: {}, ...patch };
}

function pos(side: 'long' | 'short'): ManagedPosition {
  const mods = defaultHookModules();
  return {
    id: 'p',
    accountId: 'paper',
    market: 'futures',
    symbol: 'HEDUSDT',
    side,
    qty: 1,
    entryPrice: 100,
    leverage: 5,
    marginMode: 'cross',
    openedAt: 0,
    status: 'open',
    realizedPnl: 0,
    dcaCount: 0,
    tpOrderIds: [],
    tpFilledCount: 0,
    config: { tp: mods.tp, sl: mods.sl, slx: mods.slx },
  };
}

test('hedge decide: reversal downgrades to close; long-only closes long on sell', () => {
  const rev = makeHook({ close: { ...defaultHookModules().close, reverse: true } });
  // One-way: reverse. Hedge: close.
  assert.equal(decide(rev, makeSignal({ side: 'sell' }), pos('long'), false).action, 'reverse');
  assert.equal(decide(rev, makeSignal({ side: 'sell' }), pos('long'), true).action, 'close');
  const longOnly = makeHook({ open: { ...defaultHookModules().open, positionMode: 'long_only' } });
  assert.equal(decide(longOnly, makeSignal({ side: 'sell' }), pos('long'), true).action, 'close');
  assert.equal(decide(longOnly, makeSignal({ side: 'sell' }), undefined, true).action, 'ignore');
});

// ----------------------------------------------------- grid lifecycle (e2e)

test('grid entry: partial fills average in, leftovers cancelled on close', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('GRDUSDT', 100);
  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'Grid',
    accountId: 'paper',
    market: 'futures',
    open: {
      ...mods.open,
      amount: { mode: 'volume_usd', value: 400 },
      entry: 'grid',
      grid: { count: 4, firstOfsPct: 1, lastOfsPct: 4, qtyFactor: 1, density: 1 },
    },
  });
  const send = (side: string) =>
    engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'GRDUSDT', side }, '1.1.1.1');

  const entry = await send('buy');
  assert.equal(entry.action, 'open');
  assert.match(entry.detail, /grid 4 orders/);
  await engine.settle();
  // No fills yet: 4 resting limit buys below price.
  assert.equal(db.openPositionFor('paper', 'futures', 'GRDUSDT'), undefined);
  assert.equal((await adapter.getOpenOrders('GRDUSDT')).length, 4);

  // Price dips into the first level only.
  source.setPrice('GRDUSDT', 98.9);
  await tick();
  await engine.settle();
  let p = db.openPositionFor('paper', 'futures', 'GRDUSDT');
  assert.ok(p, 'first grid level opened the position');
  assert.equal(p.qty, 1);
  assert.equal(p.entryPrice, 99);
  assert.equal(p.entryOrderIds?.length, 3, 'three grid levels still resting');

  // Deeper dip fills the rest; average across all four levels.
  source.setPrice('GRDUSDT', 95.5);
  await tick();
  await engine.settle();
  p = db.openPositionFor('paper', 'futures', 'GRDUSDT');
  assert.ok(p);
  assert.equal(p.qty, 4);
  assert.ok(Math.abs(p.entryPrice - 97.5) < 1e-9, `avg 97.5, got ${p.entryPrice}`);
  assert.equal(p.entryOrderIds?.length ?? 0, 0);

  const closed = await send('sell');
  assert.equal(closed.action, 'close');
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'GRDUSDT'), undefined);
  assert.equal((await adapter.getOpenOrders('GRDUSDT')).length, 0);
  await engine.shutdown();
});

test('grid entry: unfilled levels are cancelled when position closes early', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('GRDUSDT', 100);
  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'Grid2',
    accountId: 'paper',
    market: 'futures',
    open: {
      ...mods.open,
      amount: { mode: 'volume_usd', value: 400 },
      entry: 'grid',
      grid: { count: 4, firstOfsPct: 1, lastOfsPct: 4, qtyFactor: 1, density: 1 },
    },
  });
  await engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'GRDUSDT', side: 'buy' }, '1.1.1.1');
  source.setPrice('GRDUSDT', 98.9); // only level 1 fills
  await tick();
  await engine.settle();
  assert.equal((await adapter.getOpenOrders('GRDUSDT')).length, 3);

  await engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'GRDUSDT', side: 'sell' }, '1.1.1.1');
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'GRDUSDT'), undefined);
  assert.equal((await adapter.getOpenOrders('GRDUSDT')).length, 0, 'leftover grid levels cancelled');
  await engine.shutdown();
});

// ---------------------------------------------------- hedge lifecycle (e2e)

test('hedge mode: Both hook holds long and short at once; flat closes both', async () => {
  const { db, source, adapter, engine } = makeEnv(true);
  source.setPrice('HEDUSDT', 100);
  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'Hedge',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, amount: { mode: 'volume_usd', value: 100 } },
    sl: { ...mods.sl, enabled: true, ofsPct: 20 },
  });
  const send = (body: Record<string, unknown>) =>
    engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'HEDUSDT', ...body }, '1.1.1.1');

  const buy = await send({ side: 'buy' });
  assert.equal(buy.action, 'open');
  await engine.settle();
  // In hedge mode a sell opens the short side instead of closing the long.
  const sell = await send({ side: 'sell' });
  assert.equal(sell.action, 'open');
  await engine.settle();

  const longPos = db.openPositionFor('paper', 'futures', 'HEDUSDT', 'long');
  const shortPos = db.openPositionFor('paper', 'futures', 'HEDUSDT', 'short');
  assert.ok(longPos && shortPos, 'both sides open simultaneously');
  assert.equal(longPos.qty, 1);
  assert.equal(shortPos.qty, 1);
  assert.ok(longPos.slOrderId && shortPos.slOrderId, 'each side has its own SL');

  const exchangePositions = await adapter.getPositions();
  assert.equal(exchangePositions.length, 2);
  assert.deepEqual(exchangePositions.map((p) => p.positionSide).sort(), ['LONG', 'SHORT']);

  // SL of the long triggers without touching the short.
  source.setPrice('HEDUSDT', 79);
  await tick();
  await engine.settle();
  await tick();
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'HEDUSDT', 'long'), undefined, 'long stopped out');
  const shortAfter = db.openPositionFor('paper', 'futures', 'HEDUSDT', 'short');
  assert.ok(shortAfter, 'short survives the long SL');
  assert.equal(shortAfter.qty, 1);

  // flat closes what remains.
  const flat = await send({ side: 'buy', positionSide: 'flat' });
  assert.equal(flat.action, 'close');
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'HEDUSDT'), undefined);
  const closedShort = db.positions.find((p) => p.side === 'short' && p.status === 'closed');
  assert.ok((closedShort?.realizedPnl ?? 0) > 0, 'short closed in profit after the drop');
  await engine.shutdown();
});

test('hedge mode: long-only hook manages only its side', async () => {
  const { db, source, engine } = makeEnv(true);
  source.setPrice('HEDUSDT', 200);
  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'LongOnly',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, positionMode: 'long_only', amount: { mode: 'volume_usd', value: 100 } },
  });
  const send = (side: string) =>
    engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'HEDUSDT', side }, '1.1.1.1');

  // Sell with no long → ignored (does NOT open a short).
  const ignored = await send('sell');
  assert.equal(ignored.action, 'ignore');

  await send('buy');
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'HEDUSDT', 'long'));

  // Sell now closes the long.
  const closed = await send('sell');
  assert.equal(closed.action, 'close');
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'HEDUSDT'), undefined);
  await engine.shutdown();
});
