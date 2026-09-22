import { Router, json, type Request } from 'express';
import { z } from 'zod';
import type { TradingEngine } from '../engine/engine.js';
import type { Hook, MarketType } from '../store/types.js';
import { defaultHookModules } from '../engine/defaults.js';

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? '';
}

const marketSchema = z.enum(['spot', 'futures']);

export function buildRouter(engine: TradingEngine): Router {
  const r = Router();
  const db = engine.db;
  r.use(json({ limit: '256kb' }));

  // ---- Webhook (Finandy-compatible signal input) ----
  r.post('/hook/:id', async (req, res) => {
    const entry = await engine.handleSignal(req.params.id, req.body, clientIp(req));
    // Finandy-style: 200 with a small status body; signals are always logged.
    res.status(entry.ok ? 200 : 400).json({ ok: entry.ok, action: entry.action, detail: entry.detail });
  });

  // ---- Hooks CRUD ----
  r.get('/api/hooks', (_req, res) => res.json(db.hooks));

  r.post('/api/hooks', (req, res) => {
    const body = z
      .object({
        name: z.string().min(1),
        accountId: z.string().min(1),
        market: marketSchema,
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.message });
    const hook = db.createHook(body.data);
    res.json(hook);
  });

  r.put('/api/hooks/:id', (req, res) => {
    // The UI edits the full hook object; accept a partial patch.
    const patch = req.body as Partial<Hook>;
    delete patch.id;
    const hook = db.updateHook(req.params.id, patch);
    if (!hook) return res.status(404).json({ error: 'not found' });
    res.json(hook);
  });

  r.delete('/api/hooks/:id', (req, res) => {
    if (!db.deleteHook(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  r.get('/api/hooks/defaults', (_req, res) => res.json(defaultHookModules()));

  // ---- Signal log / positions ----
  r.get('/api/signals', (_req, res) => res.json(db.signalLog.slice(0, 200)));
  r.get('/api/positions', (_req, res) => res.json(db.positions.filter((p) => p.status === 'open')));
  r.get('/api/positions/history', (_req, res) =>
    res.json(db.positions.filter((p) => p.status === 'closed').sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))),
  );

  // Attach or replace TP/SL on an already-open exchange position (futures).
  r.post('/api/positions/manage', async (req, res) => {
    const schema = z.object({
      accountId: z.string(),
      market: marketSchema,
      symbol: z.string().min(1),
      side: z.enum(['long', 'short']).optional(),
      tp: z.any().optional(),
      sl: z.any().optional(),
      slx: z.any().optional(),
    });
    const body = schema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.message });
    try {
      const detail = await engine.manageExistingPosition(body.data);
      res.json({ ok: true, detail });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.post('/api/positions/:id/close', async (req, res) => {
    const fraction = Number((req.body as { fraction?: number })?.fraction ?? 1);
    try {
      await engine.closeManagedPosition(req.params.id, Number.isFinite(fraction) ? fraction : 1);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- Settings / accounts ----
  r.get('/api/settings', (_req, res) => {
    // Never send API secrets back to the browser.
    const s = db.settings;
    res.json({
      ...s,
      accounts: s.accounts.map((a) => ({ ...a, apiSecret: a.apiSecret ? '•••' : '' })),
    });
  });

  r.put('/api/settings', (req, res) => {
    const body = z
      .object({
        activeAccountId: z.string().optional(),
        allowedSignalIps: z.array(z.string()).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.message });
    if (body.data.activeAccountId) db.settings.activeAccountId = body.data.activeAccountId;
    if (body.data.allowedSignalIps) db.settings.allowedSignalIps = body.data.allowedSignalIps;
    db.save();
    res.json({ ok: true });
  });

  r.post('/api/accounts', (req, res) => {
    const body = z
      .object({
        label: z.string().min(1),
        exchange: z.enum(['binance', 'paper']),
        apiKey: z.string().default(''),
        apiSecret: z.string().default(''),
        paperBalanceUsd: z.number().default(10_000),
        hedgeMode: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.message });
    const account = {
      id: Math.random().toString(36).slice(2, 10),
      createdAt: Date.now(),
      ...body.data,
    };
    db.settings.accounts.push(account);
    db.save();
    res.json({ ...account, apiSecret: account.apiSecret ? '•••' : '' });
  });

  r.put('/api/accounts/:id', async (req, res) => {
    const body = z
      .object({
        label: z.string().min(1).optional(),
        hedgeMode: z.boolean().optional(),
        paperBalanceUsd: z.number().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.message });
    const account = db.settings.accounts.find((a) => a.id === req.params.id);
    if (!account) return res.status(404).json({ error: 'not found' });
    Object.assign(account, body.data);
    db.save();
    // Recreate adapters so the futures position mode is re-applied.
    if (body.data.hedgeMode !== undefined) await engine.resetAccount(account.id);
    res.json({ ...account, apiSecret: account.apiSecret ? '•••' : '' });
  });

  r.delete('/api/accounts/:id', (req, res) => {
    const s = db.settings;
    if (s.accounts.length <= 1) return res.status(400).json({ error: 'cannot remove the last account' });
    s.accounts = s.accounts.filter((a) => a.id !== req.params.id);
    if (s.activeAccountId === req.params.id) s.activeAccountId = s.accounts[0].id;
    db.save();
    res.json({ ok: true });
  });

  // ---- Market/account data ----
  const accountAndMarket = (req: Request): { accountId: string; market: MarketType } => {
    const accountId = String(req.query.account ?? db.settings.activeAccountId);
    const market = marketSchema.catch('futures').parse(req.query.market ?? 'futures');
    return { accountId, market };
  };

  r.get('/api/account/state', async (req, res) => {
    const { accountId, market } = accountAndMarket(req);
    try {
      const adapter = await engine.adapter(accountId, market);
      // Fetch parts independently so one failing endpoint (e.g. a geo/edge-
      // restricted spot call) doesn't wipe the whole view or dump an error page.
      const [b, p, o, e] = await Promise.allSettled([
        adapter.getBalances(),
        adapter.getPositions(),
        adapter.getOpenOrders(),
        adapter.accountEquity(),
      ]);
      const failed: string[] = [];
      const balances = b.status === 'fulfilled' ? b.value : (failed.push('balances'), []);
      const positions = p.status === 'fulfilled' ? p.value : (failed.push('positions'), []);
      const orders = o.status === 'fulfilled' ? o.value : (failed.push('open orders'), []);
      // Supplementary: the exchange's authoritative equity/available totals.
      // A failure here isn't surfaced as a warning — the UI falls back to
      // summing balances + position PnL.
      const equity = e.status === 'fulfilled' ? e.value : null;
      // Only reconcile when we actually have live positions to compare against.
      if (p.status === 'fulfilled') await engine.reconcile(accountId, market, positions).catch(() => {});
      let warning: string | undefined;
      if (failed.length) {
        const reason = [b, p, o].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        const msg = reason ? (reason.reason instanceof Error ? reason.reason.message : String(reason.reason)) : 'request failed';
        warning = `${market} ${failed.join(', ')} unavailable — ${msg}`;
      }
      res.json({ balances, positions, orders, equity, managed: engine.db.openPositions(accountId), warning });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.get('/api/symbols', async (req, res) => {
    const { accountId, market } = accountAndMarket(req);
    try {
      const adapter = await engine.adapter(accountId, market);
      res.json(await adapter.getSymbols());
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.get('/api/tickers', async (req, res) => {
    const { accountId, market } = accountAndMarket(req);
    try {
      const adapter = await engine.adapter(accountId, market);
      res.json(await adapter.getTickers());
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Current price for one symbol. The chart polls this for the pair it's
  // showing, so the header/last candle stay live over REST even where the
  // market websocket is blocked. Also subscribes the symbol to the price
  // stream so ws ticks refine it when they do arrive.
  r.get('/api/price', async (req, res) => {
    const { accountId, market } = accountAndMarket(req);
    const symbol = String(req.query.symbol ?? '');
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    try {
      const adapter = await engine.adapter(accountId, market);
      adapter.watchPrice(symbol);
      res.json({ price: await adapter.getPrice(symbol) });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.get('/api/klines', async (req, res) => {
    const { accountId, market } = accountAndMarket(req);
    const symbol = String(req.query.symbol ?? '');
    const interval = String(req.query.interval ?? '15m');
    const limit = Math.min(1000, Number(req.query.limit ?? 500));
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    try {
      const adapter = await engine.adapter(accountId, market);
      res.json(await adapter.getKlines(symbol, interval, limit));
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- Manual orders ----
  r.post('/api/orders', async (req, res) => {
    const schema = z.object({
      accountId: z.string(),
      market: marketSchema,
      symbol: z.string().min(1),
      side: z.enum(['buy', 'sell']),
      type: z.enum(['market', 'limit', 'stop_market']),
      qty: z.number().positive().optional(),
      // Size by a Finandy amount mode (e.g. % of portfolio) instead of a fixed
      // base quantity; resolved server-side against live balances/positions.
      amount: z
        .object({
          mode: z.enum([
            'amount',
            'volume',
            'volume_usd',
            'full_balance_pct',
            'full_balance_pct_lev',
            'free_balance_pct',
            'free_balance_pct_lev',
            'total_position_value_pct',
            'position_amount_pct',
            'position_volume_pct',
          ]),
          value: z.number().positive(),
        })
        .optional(),
      price: z.number().positive().optional(),
      stopPrice: z.number().positive().optional(),
      reduceOnly: z.boolean().optional(),
      leverage: z.number().int().min(1).max(125).optional(),
      marginMode: z.enum(['cross', 'isolated']).optional(),
      grid: z
        .object({
          count: z.number().int().min(2).max(30),
          priceMode: z.enum(['offset', 'price', 'levels']).optional(),
          firstPrice: z.number().min(0).optional(),
          lastPrice: z.number().min(0).optional(),
          levels: z
            .array(z.object({ price: z.number().min(0), qtyPct: z.number().min(0).optional() }))
            .max(30)
            .optional(),
          firstOfsPct: z.number().min(0),
          lastOfsPct: z.number().min(0),
          qtyFactor: z.number().positive().default(1),
          density: z.number().positive().default(1),
        })
        .optional(),
      tp: z.any().optional(),
      sl: z.any().optional(),
      slx: z.any().optional(),
    }).refine((d) => d.qty !== undefined || d.amount !== undefined, {
      message: 'either qty or amount is required',
    });
    const body = schema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.message });
    try {
      const orderId = await engine.manualOrder(body.data);
      res.json({ ok: true, orderId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  r.delete('/api/orders/:symbol/:orderId', async (req, res) => {
    const { accountId, market } = accountAndMarket(req);
    try {
      const adapter = await engine.adapter(accountId, market);
      await adapter.cancelOrder(req.params.symbol, req.params.orderId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Reprice a resting order (chart drag-to-move): cancel-and-replace, keeping
  // its managed-position link.
  r.post('/api/orders/:symbol/:orderId/move', async (req, res) => {
    const { accountId, market } = accountAndMarket(req);
    const price = Number((req.body as { price?: number })?.price);
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ error: 'price required' });
    try {
      const orderId = await engine.moveOrder(accountId, market, req.params.symbol, req.params.orderId, price);
      res.json({ ok: true, orderId });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return r;
}
