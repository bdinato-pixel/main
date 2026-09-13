import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db.js';
import { TradingEngine } from '../src/engine/engine.js';
import { ManualPriceSource, PaperAdapter } from '../src/exchange/paper.js';
import type { SymbolInfo } from '../src/exchange/types.js';

const SYMBOLS: SymbolInfo[] = [
  { symbol: 'PFUSDT', base: 'PF', quote: 'USDT', tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
];

function makeEnv(startUsd = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-pf-'));
  const db = new Db(join(dir, 'db.json'));
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new PaperAdapter('futures', 'paper', source, startUsd);
  const engine = new TradingEngine(db, async () => adapter);
  return { db, source, engine };
}

test('manual order sizes by % of portfolio (equity, no leverage)', async () => {
  const { db, source, engine } = makeEnv(10_000);
  source.setPrice('PFUSDT', 100);
  // 10% of 10,000 equity at price 100 → notional 1000 → qty 10.
  await engine.manualOrder({
    accountId: 'paper',
    market: 'futures',
    symbol: 'PFUSDT',
    side: 'buy',
    type: 'market',
    amount: { mode: 'full_balance_pct', value: 10 },
    leverage: 5,
  });
  await engine.settle();
  const pos = db.openPositionFor('paper', 'futures', 'PFUSDT');
  assert.ok(pos, 'position opened');
  assert.ok(Math.abs(pos.qty - 10) < 1e-6, `qty 10 (10% of equity), got ${pos.qty}`);
  await engine.shutdown();
});

test('manual order sizes by % of portfolio × leverage', async () => {
  const { db, source, engine } = makeEnv(10_000);
  source.setPrice('PFUSDT', 100);
  // 10% of 10,000 × 5x leverage at price 100 → notional 5000 → qty 50.
  await engine.manualOrder({
    accountId: 'paper',
    market: 'futures',
    symbol: 'PFUSDT',
    side: 'buy',
    type: 'market',
    amount: { mode: 'full_balance_pct_lev', value: 10 },
    leverage: 5,
  });
  await engine.settle();
  const pos = db.openPositionFor('paper', 'futures', 'PFUSDT');
  assert.ok(pos, 'position opened');
  assert.ok(Math.abs(pos.qty - 50) < 1e-6, `qty 50 (10% × 5x), got ${pos.qty}`);
  await engine.shutdown();
});

test('manual order rejects when neither qty nor a resolvable amount is given', async () => {
  const { source, engine } = makeEnv(0);
  source.setPrice('PFUSDT', 100);
  // Zero equity → full_balance_pct resolves to 0 → rejected.
  await assert.rejects(
    () =>
      engine.manualOrder({
        accountId: 'paper',
        market: 'futures',
        symbol: 'PFUSDT',
        side: 'buy',
        type: 'market',
        amount: { mode: 'full_balance_pct', value: 10 },
      }),
    /resolves to zero/,
  );
  await engine.shutdown();
});
