# TradeHook — self-hosted crypto trading terminal

A self-hosted trading terminal for **Binance Spot and USDⓈ-M Futures** with
**Finandy-compatible TradingView webhooks**. Built as a replacement for
[Finandy](https://finandy.com) smart-terminal workflows now that its futures
support is going away — your existing TradingView alert messages keep working
with minimal changes.

Everything runs on your own machine: your API keys never leave the server's
local data file, and there is no third party between your signals and the
exchange.

```
terminal/
├── server/   Node.js + TypeScript backend (REST API, webhooks, trading engine)
└── web/      React terminal UI (chart, order panel, positions, hook editor)
```

## Features

**Manual trading (terminal)**
- Candlestick chart (lightweight-charts) with entry / TP / SL / trailing lines
- Market, limit and stop-market orders; size in USDT, tokens, or % of free
  balance (× leverage on futures)
- **Order grids**: spread an amount over 2–30 limit orders, placing them by
  **% offset range**, **absolute first/last price range**, or **each price**
  (type an exact price per order, with an optional per-order quantity split);
  range modes also take a per-order quantity multiplier and a density curve
  for spacing. Unfilled levels are cancelled automatically when the position
  closes
- **Absolute price limits everywhere**: TP levels and the Stop Loss take
  either a % offset or an exact price (the price overrides the % when set),
  in both the order panel and the hook editor
- **Resizable layout**: drag the dividers between the ticker list, chart,
  order panel and the bottom tables; the sizes are remembered per browser
- Leverage and cross/isolated margin control per order
- **Hedge mode** (futures dual-side): hold a long and a short on the same
  pair simultaneously, each with its own TP/SL/trailing lifecycle —
  switchable per account in Settings
- Positions, open orders, balances, signal log and trade history tables
- Paper-trading account (simulated fills against live Binance prices) — try
  everything with zero risk before adding an API key

**Automation (Finandy-style signal hooks)**
- Webhook endpoint per hook: `POST /hook/<id>` with the familiar
  `{name, secret, side, symbol}` JSON message
- Signal processing logic matching Finandy's table: open / average / close /
  reverse depending on the current position and signal side
- Position side modes: **Both**, **Strategy** (`positionSide` /
  `{{strategy.market_position}}`), **Long only**, **Short only**
- `"positionSide": "flat"` closes the pair, strategy reversals supported
- Amount modes: tokens, quote volume, USD, full/free balance % (× leverage),
  position volume/amount % (for DCA and partial closes)
- **Take Profit grid** with per-level offsets and piece %, level reordering
  after DCA, and `"update": true` signals to move TP levels on the fly
- **Stop Loss** (% offset or absolute), recomputed after averaging, with a
  choice of **trigger source**: price touch (exchange-resident stop on
  futures) or **candle close** on a chosen timeframe — the SL fires only if
  the candle closes beyond the level, so wicks and stop-hunts through it
  don't knock you out
- **Move stop to breakeven after N TPs**: once the chosen number of TP orders
  fill, the stop is moved to the position's average entry price. It's a
  stop-loss setting, independent of the trailing module — it works with SL
  and trailing both off, and will place a stop at breakeven even if no
  initial SL was set
- **Trailing stop (SLX)**: arms at an activation profit %, trails the best
  price; also supports the candle-close trigger (arms/trails/fires on closes
  instead of ticks)
- Entry and DCA order grids per hook (same grid engine as manual trading)
- Hedge-mode hooks: Long-only / Short-only / Strategy hooks manage their own
  side of a dual position; a "Both" hook opens each side independently
  (per Finandy's hedging docs closes are not recognized in Both mode, and
  reversal exists only in one-way mode)
- Limits: open timeout, max open positions, max total/hook volume,
  whitelist/blacklist
- Option-in-signal control: check a box per option to take its value from the
  signal message instead of the saved settings
- Signal log with the raw payload, action and result of every signal
- Per-hook secret check + optional source-IP allowlist

## Quick start

Requires Node.js ≥ 20.

```bash
cd terminal
npm install
npm run build          # builds server + web UI
npm start              # serves UI + API on http://localhost:8720
```

For development (hot reload):

```bash
npm run dev:server     # tsx watch on :8720
npm run dev:web        # vite dev server on :5173 (proxies /api, /hook, /ws)
```

## Run it 24/7 (no terminal window)

`npm start` keeps a terminal open. To have the terminal (and its always-on
work — the TP/SL reconcile loop, candle-close stops, trailing) run in the
background, on boot, and restart itself if it crashes, install it as a service.

**Windows — one command (recommended).** From the repo, run the bundled script
in an **Administrator** PowerShell — it builds if needed, downloads NSSM,
registers the service with the correct paths, and starts it:

```powershell
powershell -ExecutionPolicy Bypass -File terminal\scripts\install-service.ps1
```

The UI is at <http://localhost:8720>. After a `git pull`, refresh with
`... install-service.ps1 -Update`; remove with `... install-service.ps1 -Uninstall`.
If the default spot host blocks signed calls in your region, point it at an
alternate: `... install-service.ps1 -SpotBase https://api-gcp.binance.com`.
(The script self-elevates if you forget to run it as admin.)

Prefer to do it by hand, or on another OS? Build once (`npm run build`), then:

**Windows — NSSM (manual).** A true service; survives logout, auto-starts
on boot, restarts on crash. Download `nssm.exe` from <https://nssm.cc>, then in
an **Administrator** terminal (adjust the two paths — use `where node` to find
node.exe):

```bat
nssm install TradeHook "C:\Program Files\nodejs\node.exe" dist\index.js
nssm set TradeHook AppDirectory "C:\path\to\main\terminal\server"
nssm set TradeHook Start SERVICE_AUTO_START
nssm set TradeHook AppStdout "C:\path\to\main\terminal\server\logs\out.log"
nssm set TradeHook AppStderr "C:\path\to\main\terminal\server\logs\err.log"
nssm start TradeHook
```

The UI stays at <http://localhost:8720>. To update after `git pull`:
`npm run build`, then `nssm restart TradeHook`. Stop/remove with
`nssm stop TradeHook` / `nssm remove TradeHook confirm`.

> **Important:** `AppDirectory` must be `terminal\server` (or set
> `nssm set TradeHook AppEnvironmentExtra DATA_FILE=C:\...\terminal\server\data\terminal.json`)
> so the service uses the **same** `data/terminal.json` as `npm start` — the one
> holding your accounts, hooks and managed positions. A different working
> directory starts from an empty paper-only database.

**Cross-platform — PM2.** `npm i -g pm2`, then from `terminal/server`:
`pm2 start dist/index.js --name tradehook && pm2 save`. On Windows also run
`npm i -g pm2-windows-startup && pm2-startup install`; on Linux/macOS run the
command `pm2 startup` prints. Update: `npm run build && pm2 restart tradehook`.

**Simplest — Task Scheduler (Windows, no install).** Create a task, trigger
*At log on* (or *At startup*), action *Start a program* → program `node`,
arguments `dist\index.js`, **Start in** `C:\path\to\main\terminal\server`; tick
*Run whether user is logged on or not* and *Hidden*. (No crash auto-restart —
prefer NSSM for that.)

**Linux/macOS — systemd/launchd** work the same way: run `node dist/index.js`
with the working directory set to `terminal/server`.

## Access it from your phone (Tailscale)

[Tailscale](https://tailscale.com) puts your PC and phone on one private network
so you can reach the terminal from anywhere — without exposing it to the public
internet or forwarding ports.

One time:

1. Install Tailscale and sign in on **both** the PC and your phone (same
   account). Windows installer: <https://tailscale.com/download/windows>.
2. Enable **MagicDNS** and **HTTPS Certificates** for your tailnet in the admin
   console: <https://login.tailscale.com/admin/dns>.

Then, on the PC, run the bundled script (Administrator PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File terminal\scripts\tailscale-access.ps1
```

It uses `tailscale serve` to publish the terminal at
`https://<your-pc>.<tailnet>.ts.net` — reachable by any device on your tailnet,
over HTTPS, with **no firewall changes** and nothing exposed publicly. The
script prints the exact URL; open it in your phone's browser (with the Tailscale
app connected). Undo with `... tailscale-access.ps1 -Off`.

Equivalent manual command:

```powershell
tailscale serve --bg 8720          # then: tailscale serve status
```

Prefer a plain IP instead of Serve? Run the script with `-DirectPort` to open
`http://<tailscale-ip>:8720` (adds a firewall rule scoped to the Tailscale
interface). Keep API keys withdrawal-disabled and the machine private regardless.

Open the UI, go to **Settings**, and either stay on the default **paper
trading** account or add a Binance account with an API key
(*Enable Reading* + *Enable Spot & Margin Trading* and/or *Enable Futures*;
**never enable withdrawals**).

State (accounts, hooks, positions, signal log) lives in
`server/data/terminal.json` — back it up, and keep the machine private since
API keys are stored there.

## Connecting a TradingView alert

1. **Hooks → New signal hook**, configure the modules, **Save**.
2. Copy the **Webhook URL** into the alert's *Notifications → Webhook URL*
   field, and the generated **signal message** into the alert message:

```json
{
  "name": "Hook 1",
  "secret": "8701bac3a497",
  "side": "buy",
  "symbol": "{{ticker}}"
}
```

3. For indicator alerts create two alerts (one with `"side": "buy"`, one with
   `"side": "sell"`). A strategy needs only one alert — set the hook's
   position mode to **Strategy** and the message gains
   `"positionSide": "{{strategy.market_position}}"`.

The server must be reachable from TradingView (public IP / reverse proxy /
tunnel). Restrict callers to TradingView's published alert IPs in Settings if
exposed to the internet. The **Send test BUY/SELL** buttons on the hook page
simulate an incoming signal without TradingView.

### Signal message reference

| Field | Meaning |
| --- | --- |
| `name` | Informational hook name |
| `secret` | Must match the hook's secret |
| `side` | `buy` or `sell` |
| `symbol` | Pair; `BINANCE:BTCUSDT` / `BTCUSDT.P` are normalized |
| `positionSide` | `long` / `short` / `flat` (strategies); `flat` closes |
| `open.amount`, `dca.amount`, `close.amount` | Override sizes (when the option is signal-controlled) |
| `sl.ofs`, `slx.ofs`, `slx.trail` | Override SL / trailing settings |
| `tp.orders[{ofs,price,piece}]` | Override TP levels |
| `tp.update: true` | Replace TP levels on the open position (needs *Update by signal*) |

Processing (position mode **Both**, per Finandy's docs):

| Signal | No position | Long open | Short open |
| --- | --- | --- | --- |
| `buy` | Open long | Average (if DCA on) | Close / reverse |
| `sell` | Open short | Close / reverse | Average (if DCA on) |

## Geo-restricted networks

Binance returns HTTP 451 from some cloud/datacenter IPs. Keyless market data
for paper trading uses the `data-api.binance.vision` mirror automatically
(spot). For signed trading you need a location/IP Binance accepts; the REST
and websocket bases can be overridden if you route through your own proxy:

```
BINANCE_SPOT_BASE, BINANCE_FUTURES_BASE, BINANCE_SPOT_WS, BINANCE_FUTURES_WS
```

Other environment variables: `PORT` (default 8720), `DATA_FILE`, `WEB_DIST`.

## Testing

```bash
npm test    # engine unit + lifecycle tests (paper adapter, no network)
```

Covers the decision table, amount modes, TP grid planning, trailing state
machine, quantization, signal parsing, and full open → DCA → partial TP →
close / reverse / trailing lifecycles.

## Current limitations (vs. Finandy)

- Fibonacci grids, grid auto-update levels, floating orders and Martingale
  are not implemented yet
- Switching one-way ↔ hedge on Binance requires no open futures positions
  (exchange rule); switch it in Settings only when flat
- Binance only (adapter interface is exchange-agnostic; Bybit/OKX would be
  new adapters), plus the built-in paper exchange
- Spot SL is virtual (monitored server-side) since Binance spot cannot hold
  TP and SL simultaneously; futures SL/TP are real exchange orders — except
  **candle-close SLs**, which are always virtual because no exchange order
  type can express "confirmed on close" (a price-touch SL keeps protecting
  you if the server dies; a candle-close SL does not)
- The SL "Order book" trigger source Finandy offers (best bid/ask instead
  of last price) is not implemented
- Trailing stops and virtual orders are evaluated server-side — the server
  must be running for them to fire (real SL/TP orders rest on the exchange)
- Positions opened while the server was offline are shown but not managed
- Paper fills ignore trading fees and slippage

## Disclaimer

This is trading software that can place real orders with real money. Use it
at your own risk, start with the paper account, and never give it API keys
with withdrawal permissions.
