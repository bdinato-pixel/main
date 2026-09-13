import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, DbShape, Hook, ManagedPosition, PendingIntent, SignalLogEntry } from './types.js';
import { defaultHookModules } from '../engine/defaults.js';

const MAX_SIGNAL_LOG = 500;

function defaults(): DbShape {
  return {
    settings: {
      accounts: [
        {
          id: 'paper',
          label: 'Paper trading',
          exchange: 'paper',
          apiKey: '',
          apiSecret: '',
          paperBalanceUsd: 10_000,
          createdAt: Date.now(),
        },
      ],
      activeAccountId: 'paper',
      allowedSignalIps: [],
    },
    hooks: [],
    positions: [],
    signalLog: [],
    lastCloseAt: {},
    pendingIntents: {},
  };
}

/**
 * Tiny JSON-file persistence with atomic writes. Single-user terminal state
 * (hooks, managed positions, signal log) — not a market-data store.
 */
export class Db {
  private data: DbShape;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DbShape>;
      this.data = { ...defaults(), ...parsed };
    } else {
      this.data = defaults();
      this.flush();
    }
  }

  get settings(): AppSettings {
    return this.data.settings;
  }

  get hooks(): Hook[] {
    return this.data.hooks;
  }

  get positions(): ManagedPosition[] {
    return this.data.positions;
  }

  get signalLog(): SignalLogEntry[] {
    return this.data.signalLog;
  }

  get lastCloseAt(): Record<string, number> {
    return this.data.lastCloseAt;
  }

  get pendingIntents(): Record<string, PendingIntent> {
    // Older db files predate this field.
    if (!this.data.pendingIntents) this.data.pendingIntents = {};
    return this.data.pendingIntents;
  }

  hookById(id: string): Hook | undefined {
    return this.data.hooks.find((h) => h.id === id);
  }

  createHook(partial: Partial<Hook> & Pick<Hook, 'name' | 'accountId' | 'market'>): Hook {
    const hook: Hook = {
      id: randomUUID().replaceAll('-', '').slice(0, 20),
      secret: randomUUID().replaceAll('-', '').slice(0, 12),
      enabled: true,
      fixedSymbol: '',
      signalControlled: [],
      createdAt: Date.now(),
      ...defaultHookModules(),
      ...partial,
    };
    this.data.hooks.push(hook);
    this.save();
    return hook;
  }

  updateHook(id: string, patch: Partial<Hook>): Hook | undefined {
    const hook = this.hookById(id);
    if (!hook) return undefined;
    Object.assign(hook, patch, { id: hook.id, createdAt: hook.createdAt });
    this.save();
    return hook;
  }

  deleteHook(id: string): boolean {
    const before = this.data.hooks.length;
    this.data.hooks = this.data.hooks.filter((h) => h.id !== id);
    this.save();
    return this.data.hooks.length !== before;
  }

  addSignalLog(entry: Omit<SignalLogEntry, 'id'>): SignalLogEntry {
    const full: SignalLogEntry = { id: randomUUID(), ...entry };
    this.data.signalLog.unshift(full);
    if (this.data.signalLog.length > MAX_SIGNAL_LOG) {
      this.data.signalLog.length = MAX_SIGNAL_LOG;
    }
    this.save();
    return full;
  }

  upsertPosition(pos: ManagedPosition): void {
    const i = this.data.positions.findIndex((p) => p.id === pos.id);
    if (i >= 0) this.data.positions[i] = pos;
    else this.data.positions.push(pos);
    this.save();
  }

  openPositionFor(accountId: string, market: string, symbol: string, side?: 'long' | 'short'): ManagedPosition | undefined {
    return this.data.positions.find(
      (p) =>
        p.status === 'open' &&
        p.accountId === accountId &&
        p.market === market &&
        p.symbol === symbol &&
        (side === undefined || p.side === side),
    );
  }

  openPositions(accountId?: string): ManagedPosition[] {
    return this.data.positions.filter((p) => p.status === 'open' && (!accountId || p.accountId === accountId));
  }

  markClosed(pos: ManagedPosition, realizedPnl: number): void {
    pos.status = 'closed';
    pos.closedAt = Date.now();
    pos.realizedPnl = realizedPnl;
    this.data.lastCloseAt[`${pos.accountId}:${pos.market}:${pos.symbol}`] = pos.closedAt;
    // Keep history bounded.
    const closed = this.data.positions.filter((p) => p.status === 'closed');
    if (closed.length > 200) {
      const cutoff = closed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))[199]?.closedAt ?? 0;
      this.data.positions = this.data.positions.filter((p) => p.status === 'open' || (p.closedAt ?? 0) >= cutoff);
    }
    this.save();
  }

  /** Debounced save; call flush() on shutdown. */
  save(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 250);
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
