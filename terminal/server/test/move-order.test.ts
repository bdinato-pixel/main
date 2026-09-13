import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db.js';
import { TradingEngine } from '../src/engine/engine.js';
import { ManualPriceSource, PaperAdapter } from '../src/exchange/paper.js';
import { defaultSlModule, defaultTpModule } from '../src/engine/defaults.js';
import type { SymbolInfo } from '../src/exchange/types.js';

const SYMBOLS: SymbolInfo[] = [
  { symbol: 'MVUSDT', base: 'MV', quote: 'USDT', tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
];

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-move-'));
  const db = new Db(join(dir, 'db.json'));
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new PaperAdapter('futures', 'paper', source, 10_000);
  const engine = new TradingEngine(db, async () => adapter);
  return { db, source, adapter, engine };
}

async function openWithProtection(engine: TradingEngine) {
  await engine.manualOrder({
    accountId: 'paper',
    market: 'futures',
    symbol: 'MVUSDT',
    side: 'buy',
    type: 'market',
    qty: 1,
    tp: { ...defaultTpModule(), enabled: true, orders: [{ ofsPct: 5, price: 0, piecePct: 100 }] },
    sl: { ...defaultSlModule(), enabled: true, ofsPct: 5 },
  });
  await engine.settle();
}

test('moveOrder repositions a resting SL and re-links it to the position', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('MVUSDT', 100);
  await openWithProtection(engine);

  let pos = db.openPositionFor('paper', 'futures', 'MVUSDT');
  assert.ok(pos?.slOrderId, 'SL placed');
  const oldSl = pos.slOrderId;
  assert.ok(Math.abs((pos.slPrice ?? 0) - 95) < 1e-9, `SL at 95, got ${pos.slPrice}`);

  const newId = await engine.moveOrder('paper', 'futures', 'MVUSDT', oldSl, 90);
  await engine.settle();

  pos = db.openPositionFor('paper', 'futures', 'MVUSDT');
  assert.notEqual(newId, oldSl, 'new order id');
  assert.equal(pos.slOrderId, newId, 'position points at the new SL order');
  assert.ok(Math.abs((pos.slPrice ?? 0) - 90) < 1e-9, `SL price updated to 90, got ${pos.slPrice}`);

  const orders = await adapter.getOpenOrders('MVUSDT');
  assert.ok(!orders.some((o) => o.orderId === oldSl), 'old SL cancelled');
  const stops = orders.filter((o) => o.type === 'STOP_MARKET');
  assert.equal(stops.length, 1, 'one SL resting');
  assert.ok(Math.abs(stops[0].stopPrice - 90) < 1e-9, 'SL resting at 90');

  await engine.shutdown();
});

test('moveOrder repositions a resting TP and updates tpLevels', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('MVUSDT', 100);
  await openWithProtection(engine);

  let pos = db.openPositionFor('paper', 'futures', 'MVUSDT');
  assert.equal(pos?.tpOrderIds.length, 1, 'one TP placed');
  const oldTp = pos.tpOrderIds[0];

  const newId = await engine.moveOrder('paper', 'futures', 'MVUSDT', oldTp, 110);
  await engine.settle();

  pos = db.openPositionFor('paper', 'futures', 'MVUSDT');
  assert.equal(pos.tpOrderIds[0], newId, 'position points at the new TP order');
  assert.ok(pos.tpLevels && Math.abs(pos.tpLevels[0].price - 110) < 1e-9, 'tpLevels price updated to 110');

  const orders = await adapter.getOpenOrders('MVUSDT');
  assert.ok(!orders.some((o) => o.orderId === oldTp), 'old TP cancelled');
  const tps = orders.filter((o) => o.type === 'LIMIT' && o.side === 'SELL');
  assert.equal(tps.length, 1, 'one TP resting');
  assert.ok(Math.abs(tps[0].price - 110) < 1e-9, 'TP resting at 110');

  await engine.shutdown();
});

test('moveOrder rejects an unknown order id', async () => {
  const { source, engine } = makeEnv();
  source.setPrice('MVUSDT', 100);
  await openWithProtection(engine);
  await assert.rejects(() => engine.moveOrder('paper', 'futures', 'MVUSDT', 'nope-123', 99), /not found/i);
  await engine.shutdown();
});
