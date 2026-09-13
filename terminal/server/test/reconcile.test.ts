import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db.js';
import { TradingEngine } from '../src/engine/engine.js';
import { ManualPriceSource, PaperAdapter } from '../src/exchange/paper.js';
import { defaultSlModule, defaultSlxModule, defaultTpModule } from '../src/engine/defaults.js';
import type { SymbolInfo } from '../src/exchange/types.js';

const SYMBOLS: SymbolInfo[] = [
  { symbol: 'ENAUSDT', base: 'ENA', quote: 'USDT', tickSize: 0.0001, stepSize: 1, minQty: 1, minNotional: 5 },
];

/**
 * Paper adapter that never delivers fills to its listeners — simulates a
 * dropped/missed user-data stream, so the engine only ever learns about the
 * position by reconciling against the exchange.
 */
class NoFillPaperAdapter extends PaperAdapter {
  onFill(): void {
    /* swallow: the engine never hears the fill */
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('reconcile adopts a filled position whose fill event was missed and places TP/SL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-reconcile-'));
  const db = new Db(join(dir, 'db.json'));
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new NoFillPaperAdapter('futures', 'paper', source, 10_000);
  const engine = new TradingEngine(db, async () => adapter);
  source.setPrice('ENAUSDT', 0.14);

  // Marketable limit buy (fills immediately) with a 2-level TP and an SL.
  // Because fills are swallowed, no managed position is created the normal way.
  const orderId = await engine.manualOrder({
    accountId: 'paper',
    market: 'futures',
    symbol: 'ENAUSDT',
    side: 'buy',
    type: 'limit',
    qty: 500,
    price: 0.14, // at/above last → marketable, fills now
    leverage: 20,
    tp: {
      ...defaultTpModule(),
      enabled: true,
      orders: [
        { ofsPct: 3, price: 0, piecePct: 50 },
        { ofsPct: 6, price: 0, piecePct: 50 },
      ],
    },
    sl: { ...defaultSlModule(), enabled: true, ofsPct: 5 },
    slx: { ...defaultSlxModule(), enabled: false },
  });
  assert.ok(orderId);
  await engine.settle();
  await tick();

  // The exchange has the position, but the terminal doesn't manage it yet
  // (this is the reported bug: position open, no TPs on the exchange).
  assert.equal(db.openPositionFor('paper', 'futures', 'ENAUSDT'), undefined, 'not managed before reconcile');
  assert.equal((await adapter.getPositions()).length, 1, 'exchange position exists');
  assert.equal(Object.keys(db.pendingIntents).length, 1, 'intent persisted for reconcile/restart');

  // Reconcile adopts it and places protection.
  await engine.reconcile('paper', 'futures');
  await engine.settle();

  const pos = db.openPositionFor('paper', 'futures', 'ENAUSDT');
  assert.ok(pos, 'position adopted by reconcile');
  assert.equal(pos.side, 'long');
  assert.ok(Math.abs(pos.qty - 500) < 1e-6, `qty taken from exchange, got ${pos.qty}`);
  assert.equal(pos.tpOrderIds.length, 2, 'two TP orders placed after adoption');
  assert.ok(pos.slOrderId, 'SL order placed after adoption');
  assert.equal(Object.keys(db.pendingIntents).length, 0, 'intent consumed');

  const orders = await adapter.getOpenOrders('ENAUSDT');
  assert.equal(orders.filter((o) => o.type === 'LIMIT' && o.side === 'SELL').length, 2, 'TP sells resting');
  assert.equal(orders.filter((o) => o.type === 'STOP_MARKET').length, 1, 'SL resting');

  // Idempotent: a second reconcile makes no duplicate position or orders.
  await engine.reconcile('paper', 'futures');
  await engine.settle();
  assert.equal(db.openPositions('paper').length, 1, 'no duplicate managed position');
  assert.equal((await adapter.getOpenOrders('ENAUSDT')).length, 3, 'no duplicate protective orders');

  await engine.shutdown();
});

test('reconcile does not adopt an exchange position with no matching intent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-reconcile2-'));
  const db = new Db(join(dir, 'db.json'));
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new NoFillPaperAdapter('futures', 'paper', source, 10_000);
  const engine = new TradingEngine(db, async () => adapter);
  source.setPrice('ENAUSDT', 0.14);

  // A position opened directly on the exchange (no terminal intent), e.g. a
  // manual trade in the Binance app — the terminal must not adopt it.
  await adapter.placeOrder({ symbol: 'ENAUSDT', side: 'BUY', type: 'MARKET', qty: 100 });
  assert.equal((await adapter.getPositions()).length, 1, 'exchange position exists');

  await engine.reconcile('paper', 'futures');
  await engine.settle();
  assert.equal(db.openPositions('paper').length, 0, 'unrelated exchange position left unmanaged');

  await engine.shutdown();
});

test('persisted intents survive a restart and reconcile after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-reconcile3-'));
  const dbFile = join(dir, 'db.json');
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new NoFillPaperAdapter('futures', 'paper', source, 10_000);
  source.setPrice('ENAUSDT', 0.14);

  // First engine: place a resting (non-marketable) buy limit so the intent is
  // persisted but nothing has filled yet.
  const db1 = new Db(dbFile);
  const engine1 = new TradingEngine(db1, async () => adapter);
  await engine1.manualOrder({
    accountId: 'paper',
    market: 'futures',
    symbol: 'ENAUSDT',
    side: 'buy',
    type: 'limit',
    qty: 500,
    price: 0.12, // below last → rests, does not fill
    leverage: 20,
    tp: { ...defaultTpModule(), enabled: true, orders: [{ ofsPct: 3, price: 0, piecePct: 100 }] },
    sl: { ...defaultSlModule(), enabled: true, ofsPct: 5 },
  });
  await engine1.settle();
  assert.equal(Object.keys(db1.pendingIntents).length, 1, 'intent persisted');
  await engine1.shutdown();

  // "Restart": new engine from the same db file. The resting order fills while
  // it was down (drop the price), and the fill is never heard.
  const db2 = new Db(dbFile);
  const engine2 = new TradingEngine(db2, async () => adapter);
  assert.equal(Object.keys(db2.pendingIntents).length, 1, 'intent restored on restart');
  // Between the SL (0.114) and the entry (0.12): fills the resting buy limit
  // without tripping the stop when it is later placed.
  source.setPrice('ENAUSDT', 0.118);
  await tick();
  assert.equal((await adapter.getPositions()).length, 1, 'order filled while engine was down');

  await engine2.reconcile('paper', 'futures');
  await engine2.settle();
  const pos = db2.openPositionFor('paper', 'futures', 'ENAUSDT');
  assert.ok(pos, 'restored intent lets reconcile adopt the position');
  assert.equal(pos.tpOrderIds.length, 1, 'TP placed');
  assert.ok(pos.slOrderId, 'SL placed');

  await engine2.shutdown();
});
