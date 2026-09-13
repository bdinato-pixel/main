import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import express from 'express';
import { loadConfig } from './config.js';
import { Db } from './store/db.js';
import { TradingEngine, type AdapterFactory } from './engine/engine.js';
import { BinanceAdapter } from './exchange/binance/adapter.js';
import { PaperAdapter } from './exchange/paper.js';
import { BinancePublicSource } from './exchange/binancePublic.js';
import { buildRouter } from './api/routes.js';
import { attachWsHub } from './api/wsHub.js';

const config = loadConfig();
const db = new Db(config.dataFile);

const adapterFactory: AdapterFactory = async (accountId, market) => {
  const account = db.settings.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`Unknown account ${accountId}`);
  if (account.exchange === 'paper') {
    return new PaperAdapter(market, accountId, new BinancePublicSource(market), account.paperBalanceUsd);
  }
  const adapter = new BinanceAdapter(market, accountId, {
    apiKey: account.apiKey,
    apiSecret: account.apiSecret,
  });
  await adapter.init();
  return adapter;
};

const engine = new TradingEngine(db, adapterFactory);
// Safety net: adopt filled positions whose real-time fill event was missed and
// place their TP/SL, so protection isn't lost to a websocket gap or restart.
engine.startBackgroundReconcile();

const app = express();
app.use(buildRouter(engine));

if (existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^\/(?!api|hook|ws).*/u, (_req, res) => res.sendFile('index.html', { root: config.webDist }));
}

const server = createServer(app);
attachWsHub(server, engine);

server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`terminal server listening on http://localhost:${config.port}`);
  console.log(`webhook base: http://localhost:${config.port}/hook/<hook-id>`);
});

const shutdown = async (): Promise<void> => {
  await engine.shutdown();
  server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
