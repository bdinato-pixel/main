import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db.js';
import { TradingEngine } from '../src/engine/engine.js';
import { ManualPriceSource, PaperAdapter } from '../src/exchange/paper.js';
import { defaultHookModules } from '../src/engine/defaults.js';
import type { SymbolInfo } from '../src/exchange/types.js';

const SYMBOLS: SymbolInfo[] = ['TESTUSDT', 'REVUSDT', 'TRLUSDT', 'FLTUSDT', 'BEUSDT'].map((symbol) => ({
  symbol,
  base: symbol.replace('USDT', ''),
  quote: 'USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
}));

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-test-'));
  const db = new Db(join(dir, 'db.json'));
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new PaperAdapter('futures', 'paper', source, 10_000);
  const engine = new TradingEngine(db, async () => adapter);
  return { db, source, adapter, engine };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('signal lifecycle: open → TP/SL placement → DCA reorder → partial TP → close', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('TESTUSDT', 100);

  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'Hook 1',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, amount: { mode: 'volume_usd', value: 50 } },
    dca: { ...mods.dca, enabled: true, amount: { mode: 'position_volume_pct', value: 100 } },
    tp: {
      ...mods.tp,
      enabled: true,
      orders: [
        { ofsPct: 1, price: 0, piecePct: 50 },
        { ofsPct: 2, price: 0, piecePct: 50 },
      ],
    },
    sl: { ...mods.sl, enabled: true, ofsPct: 15 },
  });

  const send = (body: Record<string, unknown>) =>
    engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'TESTUSDT', ...body }, '1.1.1.1');

  // 1. Open long.
  let entry = await send({ side: 'buy' });
  assert.equal(entry.action, 'open');
  assert.ok(entry.ok, entry.detail);
  await engine.settle();
  let pos = db.openPositionFor('paper', 'futures', 'TESTUSDT');
  assert.ok(pos, 'position should exist');
  assert.equal(pos.side, 'long');
  assert.equal(pos.qty, 0.5); // 50 USDT / 100
  assert.equal(pos.entryPrice, 100);
  assert.equal(pos.tpOrderIds.length, 2, 'two TP orders placed');
  assert.ok(pos.slOrderId, 'SL order placed');
  assert.ok(Math.abs((pos.slPrice ?? 0) - 85) < 1e-9, `SL at 85, got ${pos.slPrice}`);
  const orders = await adapter.getOpenOrders('TESTUSDT');
  assert.equal(orders.filter((o) => o.type === 'LIMIT' && o.side === 'SELL').length, 2);
  assert.equal(orders.filter((o) => o.type === 'STOP_MARKET').length, 1);

  // 2. Price dips → DCA doubles the position volume; TP/SL reordered.
  source.setPrice('TESTUSDT', 90);
  await tick();
  entry = await send({ side: 'buy' });
  assert.equal(entry.action, 'dca');
  assert.ok(entry.ok, entry.detail);
  await engine.settle();
  pos = db.openPositionFor('paper', 'futures', 'TESTUSDT');
  assert.ok(pos);
  assert.equal(pos.dcaCount, 1);
  assert.ok(pos.qty > 0.5, 'position grew');
  assert.ok(pos.entryPrice < 100 && pos.entryPrice > 90, 'average moved down');
  // TP reordered at % from the new average.
  const tp1 = pos.entryPrice * 1.01;
  const ordersAfter = await adapter.getOpenOrders('TESTUSDT');
  const tpPrices = ordersAfter.filter((o) => o.type === 'LIMIT').map((o) => o.price).sort((a, b) => a - b);
  assert.ok(Math.abs(tpPrices[0] - tp1) < 0.02, `TP1 ~${tp1}, got ${tpPrices[0]}`);

  // 3. Price reaches TP1 only → partial close.
  const qtyBefore = pos.qty;
  source.setPrice('TESTUSDT', Math.round(tp1 * 1.001 * 100) / 100);
  await tick();
  await engine.settle();
  pos = db.openPositionFor('paper', 'futures', 'TESTUSDT');
  assert.ok(pos, 'position still open after partial TP');
  assert.equal(pos.tpFilledCount, 1);
  assert.ok(pos.qty < qtyBefore, 'quantity reduced by TP fill');
  assert.ok(pos.realizedPnl > 0, 'TP realized profit');

  // 4. Sell signal closes the remainder.
  entry = await send({ side: 'sell' });
  assert.equal(entry.action, 'close');
  assert.ok(entry.ok, entry.detail);
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'TESTUSDT'), undefined);
  const closed = db.positions.find((p) => p.symbol === 'TESTUSDT');
  assert.equal(closed?.status, 'closed');
  assert.ok((closed?.realizedPnl ?? 0) > 0, 'profitable round trip');
  // Remaining protective orders cancelled.
  assert.equal((await adapter.getOpenOrders('TESTUSDT')).length, 0);

  await engine.shutdown();
});

test('breakeven-after-TP moves the stop to entry with trailing disabled', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('BEUSDT', 100);

  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'BE',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, amount: { mode: 'volume_usd', value: 100 } },
    tp: {
      ...mods.tp,
      enabled: true,
      orders: [
        { ofsPct: 1, price: 0, piecePct: 50 },
        { ofsPct: 2, price: 0, piecePct: 50 },
      ],
    },
    // No initial SL and trailing OFF — only breakeven-after-first-TP is set.
    sl: { ...mods.sl, enabled: false, breakevenAfterTp: 1 },
    slx: { ...mods.slx, enabled: false },
  });

  await engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'BEUSDT', side: 'buy' }, '1.1.1.1');
  await engine.settle();
  let pos = db.openPositionFor('paper', 'futures', 'BEUSDT');
  assert.ok(pos, 'position opened');
  assert.equal(pos.tpOrderIds.length, 2, 'two TP orders placed');
  assert.equal(pos.slOrderId, undefined, 'no stop before the first TP fills');

  // Price reaches TP1 (+1%) → first TP fills → stop should appear at entry.
  source.setPrice('BEUSDT', 101.01);
  await tick();
  await engine.settle();
  pos = db.openPositionFor('paper', 'futures', 'BEUSDT');
  assert.ok(pos, 'position still open after partial TP');
  assert.equal(pos.tpFilledCount, 1);
  assert.ok(pos.slOrderId, 'breakeven stop placed after TP1');
  assert.ok(Math.abs((pos.slPrice ?? 0) - 100) < 1e-9, `stop at entry 100, got ${pos.slPrice}`);
  const stops = (await adapter.getOpenOrders('BEUSDT')).filter((o) => o.type === 'STOP_MARKET');
  assert.equal(stops.length, 1);
  assert.ok(Math.abs(stops[0].stopPrice - 100) < 1e-9);

  await engine.shutdown();
});

test('reversal closes the position and opens the opposite side', async () => {
  const { db, source, engine } = makeEnv();
  source.setPrice('REVUSDT', 200);

  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'Rev',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, amount: { mode: 'volume_usd', value: 100 } },
    close: { ...mods.close, reverse: true },
  });
  const send = (side: string) =>
    engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'REVUSDT', side }, '1.1.1.1');

  await send('buy');
  await engine.settle();
  let pos = db.openPositionFor('paper', 'futures', 'REVUSDT');
  assert.equal(pos?.side, 'long');
  assert.equal(pos?.qty, 0.5);

  const entry = await send('sell');
  assert.equal(entry.action, 'reverse');
  await engine.settle();
  pos = db.openPositionFor('paper', 'futures', 'REVUSDT');
  assert.equal(pos?.side, 'short', 'reversed to short');
  assert.equal(pos?.qty, 0.5);
  await engine.shutdown();
});

test('trailing stop arms on profit and closes on pullback', async () => {
  const { db, source, engine } = makeEnv();
  source.setPrice('TRLUSDT', 100);

  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'Trail',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, amount: { mode: 'volume_usd', value: 50 } },
    slx: { ...mods.slx, enabled: true, activationOfsPct: 1, trailPct: 0.5 },
  });
  await engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'TRLUSDT', side: 'buy' }, '1.1.1.1');
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'TRLUSDT'));

  source.setPrice('TRLUSDT', 101); // arms
  await tick();
  source.setPrice('TRLUSDT', 103); // trails to ~102.485
  await tick();
  source.setPrice('TRLUSDT', 102); // pullback through the stop
  await tick();
  await engine.settle();
  await tick();
  await engine.settle();

  const pos = db.openPositionFor('paper', 'futures', 'TRLUSDT');
  assert.equal(pos, undefined, 'trailing stop closed the position');
  const closed = db.positions.find((p) => p.symbol === 'TRLUSDT');
  assert.ok((closed?.realizedPnl ?? 0) > 0, 'closed in profit');
  await engine.shutdown();
});

test('positionSide flat closes; wrong secret and disabled hooks are rejected', async () => {
  const { db, source, engine } = makeEnv();
  source.setPrice('FLTUSDT', 50);
  const hook = db.createHook({ name: 'Flat', accountId: 'paper', market: 'futures' });
  const base = { name: hook.name, symbol: 'FLTUSDT' };

  const bad = await engine.handleSignal(hook.id, { ...base, secret: 'wrong', side: 'buy' }, '1.1.1.1');
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /secret/i);

  await engine.handleSignal(hook.id, { ...base, secret: hook.secret, side: 'buy' }, '1.1.1.1');
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'FLTUSDT'));

  const flat = await engine.handleSignal(
    hook.id,
    { ...base, secret: hook.secret, side: 'buy', positionSide: 'flat' },
    '1.1.1.1',
  );
  assert.equal(flat.action, 'close');
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'FLTUSDT'), undefined);

  db.updateHook(hook.id, { enabled: false });
  const ignored = await engine.handleSignal(hook.id, { ...base, secret: hook.secret, side: 'buy' }, '1.1.1.1');
  assert.equal(ignored.ok, false);
  assert.match(ignored.detail, /disabled/i);
  await engine.shutdown();
});
