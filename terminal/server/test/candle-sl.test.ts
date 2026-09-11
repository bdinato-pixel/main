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

const SYMBOLS: SymbolInfo[] = ['CDLUSDT', 'CTRUSDT'].map((symbol) => ({
  symbol,
  base: symbol.replace('USDT', ''),
  quote: 'USDT',
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 5,
}));

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-cdl-'));
  const db = new Db(join(dir, 'db.json'));
  const source = new ManualPriceSource(SYMBOLS);
  const adapter = new PaperAdapter('futures', 'paper', source, 10_000);
  const engine = new TradingEngine(db, async () => adapter);
  return { db, source, adapter, engine };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('candle-close SL: wicks through the level do not trigger, a close does', async () => {
  const { db, source, adapter, engine } = makeEnv();
  source.setPrice('CDLUSDT', 100);
  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'CandleSL',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, amount: { mode: 'volume_usd', value: 100 } },
    sl: { ...mods.sl, enabled: true, ofsPct: 5, trigger: 'candle', candleTf: '1m' },
  });
  await engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'CDLUSDT', side: 'buy' }, '1.1.1.1');
  await engine.settle();
  let pos = db.openPositionFor('paper', 'futures', 'CDLUSDT');
  assert.ok(pos);
  // No exchange-resident stop: the SL is virtual, watching 1m closes.
  assert.equal(pos.slOrderId, undefined, 'no real STOP_MARKET for candle trigger');
  assert.equal(pos.slCandleTf, '1m');
  assert.ok(Math.abs((pos.virtualSlPrice ?? 0) - 95) < 1e-9, `SL level 95, got ${pos.virtualSlPrice}`);
  assert.equal((await adapter.getOpenOrders('CDLUSDT')).filter((o) => o.type === 'STOP_MARKET').length, 0);

  // Wick: price plunges through the level intratick — no close, no trigger.
  source.setPrice('CDLUSDT', 92);
  await tick();
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'CDLUSDT'), 'wick did not stop the position out');

  // Candle closes back above the level — still no trigger.
  source.closeCandle('CDLUSDT', '1m', 96, { low: 92 });
  await tick();
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'CDLUSDT'), 'close above SL keeps the position');

  // Wrong timeframe closing below the level is ignored.
  source.closeCandle('CDLUSDT', '5m', 94);
  await tick();
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'CDLUSDT'), 'other timeframe ignored');

  // 1m candle closes at/below the level → market close fires.
  source.closeCandle('CDLUSDT', '1m', 94.5);
  await tick();
  await engine.settle();
  await tick();
  await engine.settle();
  pos = db.openPositionFor('paper', 'futures', 'CDLUSDT');
  assert.equal(pos, undefined, 'candle close through SL closed the position');
  const closed = db.positions.find((p) => p.symbol === 'CDLUSDT');
  assert.equal(closed?.status, 'closed');
  await engine.shutdown();
});

test('candle-triggered trailing: arms and trails on closes, ignores ticks', async () => {
  const { db, source, engine } = makeEnv();
  source.setPrice('CTRUSDT', 100);
  const mods = defaultHookModules();
  const hook = db.createHook({
    name: 'CandleTrail',
    accountId: 'paper',
    market: 'futures',
    open: { ...mods.open, amount: { mode: 'volume_usd', value: 100 } },
    slx: { ...mods.slx, enabled: true, activationOfsPct: 1, trailPct: 0.5, trigger: 'candle', candleTf: '5m' },
  });
  await engine.handleSignal(hook.id, { name: hook.name, secret: hook.secret, symbol: 'CTRUSDT', side: 'buy' }, '1.1.1.1');
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'CTRUSDT'));

  // Ticks above activation do NOT arm candle-triggered trailing.
  source.setPrice('CTRUSDT', 102);
  await tick();
  let pos = db.openPositionFor('paper', 'futures', 'CTRUSDT');
  assert.ok(pos && !pos.trailing?.armed, 'tick did not arm candle trailing');

  // A 5m close above activation arms it and sets the stop.
  source.closeCandle('CTRUSDT', '5m', 103);
  await tick();
  pos = db.openPositionFor('paper', 'futures', 'CTRUSDT');
  assert.ok(pos?.trailing?.armed, 'close armed the trailing stop');
  assert.ok(Math.abs((pos?.trailing?.stopPrice ?? 0) - 103 * 0.995) < 1e-9);

  // A tick below the stop still does not trigger (candle mode).
  source.setPrice('CTRUSDT', 101);
  await tick();
  await engine.settle();
  assert.ok(db.openPositionFor('paper', 'futures', 'CTRUSDT'), 'tick below stop ignored in candle mode');

  // A 5m close below the stop triggers the exit.
  source.closeCandle('CTRUSDT', '5m', 102);
  await tick();
  await engine.settle();
  await tick();
  await engine.settle();
  assert.equal(db.openPositionFor('paper', 'futures', 'CTRUSDT'), undefined, 'candle close triggered trailing exit');
  const closed = db.positions.find((p) => p.symbol === 'CTRUSDT');
  assert.ok((closed?.realizedPnl ?? 0) > 0, 'trailing exit locked in profit');
  await engine.shutdown();
});
