import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceRest } from '../src/exchange/binance/rest.js';

test('non-JSON error pages produce a concise message (no HTML dump)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('<html><head><title>410 Gone</title></head><body>410 Gone</body></html>', {
      status: 410,
      statusText: 'Gone',
    })) as typeof fetch;
  try {
    const rest = new BinanceRest('spot', { apiKey: '', apiSecret: '' });
    await assert.rejects(
      () => rest.public('/api/v3/ping'),
      (e: unknown) =>
        e instanceof Error && /Binance 410/.test(e.message) && !/<html/i.test(e.message),
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test('signed requests re-sync time and retry once on -1021 (clock drift)', async () => {
  const orig = globalThis.fetch;
  let signedCalls = 0;
  let timeCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/time')) {
      timeCalls++;
      return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
    }
    signedCalls++;
    if (signedCalls === 1) {
      return new Response(
        JSON.stringify({ code: -1021, msg: "Timestamp for this request was 1000ms ahead of the server's time." }),
        { status: 400 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const rest = new BinanceRest('futures', { apiKey: 'k', apiSecret: 's' });
    const out = await rest.signed<{ ok: boolean }>('GET', '/fapi/v2/balance');
    assert.deepEqual(out, { ok: true });
    assert.equal(signedCalls, 2, 'retried the signed request once');
    assert.ok(timeCalls >= 1, 're-synced the clock');
  } finally {
    globalThis.fetch = orig;
  }
});

test('JSON errors keep the exchange code and message', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }), {
      status: 401,
      statusText: 'Unauthorized',
    })) as typeof fetch;
  try {
    const rest = new BinanceRest('spot', { apiKey: '', apiSecret: '' });
    await assert.rejects(
      () => rest.public('/api/v3/account'),
      (e: unknown) => e instanceof Error && /code -2015/.test(e.message) && /permissions/.test(e.message),
    );
  } finally {
    globalThis.fetch = orig;
  }
});
