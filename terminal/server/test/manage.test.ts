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
  { symbol: 'MNGUSDT', base: 'MNG', quote: 'USDT', tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
];

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-manage-'));
  const db = new Db(join(dir, 'db.json'));
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new PaperAdapter('futures', 'paper', source, 10_000);
  const engine = new TradingEngine(db, async () => adapter);
  return { db, source, adapter, engine };
}

const tp2 = () => ({
  ...defaultTpModule(),
  enabled: true,
  orders: [
    { ofsPct: 1, price: 0, piecePct: 50 },
    { ofsPct: 2, price: 0, piecePct: 50 },
  ],
});

test('manageExistingPosition attaches TP/SL to an unmanaged exchange position', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('MNGUSDT', 100);

  // A position that exists on the exchange but the terminal isn't managing
  // (e.g. opened before this feature). Placed directly on the adapter.
  await adapter.placeOrder({ symbol: 'MNGUSDT', side: 'BUY', type: 'MARKET', qty: 1 });
  assert.equal(db.openPositionFor('paper', 'futures', 'MNGUSDT'), undefined, 'not managed initially');

  const detail = await engine.manageExistingPosition({
    accountId: 'paper',
    market: 'futures',
    symbol: 'MNGUSDT',
    side: 'long',
    tp: tp2(),
    sl: { ...defaultSlModule(), enabled: true, ofsPct: 5 },
  });
  assert.match(detail, /now managing/);

  const pos = db.openPositionFor('paper', 'futures', 'MNGUSDT');
  assert.ok(pos, 'position is now managed');
  assert.equal(pos.side, 'long');
  assert.ok(Math.abs(pos.qty - 1) < 1e-9, `qty from exchange, got ${pos.qty}`);
  assert.equal(pos.tpOrderIds.length, 2, 'two TP orders placed');
  assert.ok(pos.slOrderId, 'SL order placed');
  assert.ok(Math.abs((pos.slPrice ?? 0) - 95) < 1e-9, `SL at 95, got ${pos.slPrice}`);

  const orders = await adapter.getOpenOrders('MNGUSDT');
  assert.equal(orders.filter((o) => o.type === 'LIMIT' && o.side === 'SELL').length, 2);
  assert.equal(orders.filter((o) => o.type === 'STOP_MARKET').length, 1);

  await engine.shutdown();
});

test('manageExistingPosition replaces protection on an already-managed position', async () => {
  const { db, adapter, engine, source } = makeEnv();
  source.setPrice('MNGUSDT', 100);
  await adapter.placeOrder({ symbol: 'MNGUSDT', side: 'BUY', type: 'MARKET', qty: 1 });

  await engine.manageExistingPosition({
    accountId: 'paper',
    market: 'futures',
    symbol: 'MNGUSDT',
    side: 'long',
    tp: tp2(),
    sl: { ...defaultSlModule(), enabled: true, ofsPct: 5 },
  });
  const first = db.openPositionFor('paper', 'futures', 'MNGUSDT');
  assert.equal(first?.tpOrderIds.length, 2);

  // Re-manage with a single TP level and no SL: old orders replaced.
  await engine.manageExistingPosition({
    accountId: 'paper',
    market: 'futures',
    symbol: 'MNGUSDT',
    side: 'long',
    tp: { ...defaultTpModule(), enabled: true, orders: [{ ofsPct: 3, price: 0, piecePct: 100 }] },
    sl: { ...defaultSlModule(), enabled: false },
  });

  const pos = db.openPositionFor('paper', 'futures', 'MNGUSDT');
  assert.ok(pos, 'still one managed position');
  assert.equal(db.openPositions('paper').length, 1, 'no duplicate managed position');
  assert.equal(pos.tpOrderIds.length, 1, 'TP replaced with a single level');
  assert.equal(pos.slOrderId, undefined, 'SL removed');
  const orders = await adapter.getOpenOrders('MNGUSDT');
  assert.equal(orders.filter((o) => o.type === 'LIMIT' && o.side === 'SELL').length, 1, 'one TP resting');
  assert.equal(orders.filter((o) => o.type === 'STOP_MARKET').length, 0, 'no SL resting');

  await engine.shutdown();
});

test('manageExistingPosition rejects when there is no open position', async () => {
  const { engine, source } = makeEnv();
  source.setPrice('MNGUSDT', 100);
  await assert.rejects(
    () => engine.manageExistingPosition({ accountId: 'paper', market: 'futures', symbol: 'MNGUSDT', tp: tp2() }),
    /No open MNGUSDT position/,
  );
  await engine.shutdown();
});
