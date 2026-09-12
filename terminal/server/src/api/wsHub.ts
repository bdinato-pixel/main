import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { TradingEngine } from '../engine/engine.js';

/**
 * Pushes state updates to connected UI clients. The UI re-fetches details
 * over REST; the socket just tells it when something changed and streams
 * price ticks for watched symbols.
 */
export function attachWsHub(server: Server, engine: TradingEngine): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (msg: unknown): void => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  engine.on('changed', () => broadcast({ type: 'changed' }));
  engine.on('log', (entry) => broadcast({ type: 'log', entry }));
  engine.onAnyPrice((symbol, price) => broadcast({ type: 'price', symbol, price }));

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello' }));
  });
}
