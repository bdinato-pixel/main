import type { Hook, ManagedPosition, PositionDir, Signal, SignalAction } from '../store/types.js';

export interface Decision {
  action: SignalAction;
  /** Direction the action targets (direction to open, or of the position). */
  dir: PositionDir;
  reason: string;
}

const opposite = (d: PositionDir): PositionDir => (d === 'long' ? 'short' : 'long');

/**
 * Finandy's signal processing table. `position` is the open managed position
 * the signal acts on: in one-way mode the pair's only position, in hedge
 * mode the position on the side the hook/signal targets (see
 * `relevantSide`). In hedge mode "Both" hooks open/average each side
 * independently and never close (per Finandy's hedging docs); reversal is
 * unavailable and downgrades to a close.
 */
export function decide(hook: Hook, signal: Signal, position: ManagedPosition | undefined, hedge = false): Decision {
  const sigDir: PositionDir = signal.side === 'buy' ? 'long' : 'short';

  // TP update signals modify an open position and nothing else.
  if (signal.tp?.update === true) {
    if (!hook.tp.updateBySignal) return { action: 'ignore', dir: sigDir, reason: 'TP update not enabled on hook' };
    if (!position) return { action: 'ignore', dir: sigDir, reason: 'TP update: no open position' };
    return { action: 'update_tp', dir: position.side, reason: 'TP levels update' };
  }

  // "positionSide": "flat" closes everything on the pair.
  if (signal.positionSide === 'flat') {
    if (!position) return { action: 'ignore', dir: sigDir, reason: 'flat: no open position' };
    if (!hook.close.enabled) return { action: 'ignore', dir: position.side, reason: 'flat: close module disabled' };
    return { action: 'close', dir: position.side, reason: 'positionSide flat' };
  }

  const mode = hook.open.positionMode;

  if (mode === 'strategy') {
    const target = signal.positionSide;
    if (!target) return { action: 'ignore', dir: sigDir, reason: 'strategy mode requires positionSide' };
    if (target === 'both') return { action: 'ignore', dir: sigDir, reason: 'invalid positionSide "both" from strategy' };
    if (!position) {
      // flat handled above; here target is long|short.
      if (target !== sigDir) return { action: 'ignore', dir: sigDir, reason: `side ${signal.side} does not open ${target}` };
      return openOrIgnore(hook, sigDir);
    }
    if (target === position.side) {
      if (sigDir === position.side) return dcaOrIgnore(hook, position.side);
      // e.g. sell while strategy stays long → partial exit.
      return closeOrIgnore(hook, position.side, 'partial exit (strategy retains position)');
    }
    // Target is the opposite direction → reversal.
    return reverseOrClose(hook, position.side, hedge);
  }

  if (!position) {
    if (mode === 'long_only' && sigDir !== 'long') return { action: 'ignore', dir: sigDir, reason: 'long-only hook' };
    if (mode === 'short_only' && sigDir !== 'short') return { action: 'ignore', dir: sigDir, reason: 'short-only hook' };
    return openOrIgnore(hook, sigDir);
  }

  if (sigDir === position.side) return dcaOrIgnore(hook, position.side);

  // Opposite signal on an open position → close (or reverse, in "both" mode).
  if (mode === 'both') return reverseOrClose(hook, position.side, hedge);
  return closeOrIgnore(hook, position.side, `close ${position.side} on ${signal.side} signal`);
}

/**
 * Which dual-side position a signal acts on in hedge mode: the hook's fixed
 * side for long/short-only hooks, the strategy's target side, or the signal
 * direction for "Both" hooks (each side runs independently).
 */
export function relevantSide(hook: Hook, signal: Signal): PositionDir | undefined {
  if (signal.positionSide === 'flat') return undefined; // any open side
  const mode = hook.open.positionMode;
  if (mode === 'long_only') return 'long';
  if (mode === 'short_only') return 'short';
  if (mode === 'strategy') {
    if (signal.positionSide === 'long' || signal.positionSide === 'short') return signal.positionSide;
    return signal.side === 'buy' ? 'long' : 'short';
  }
  return signal.side === 'buy' ? 'long' : 'short';
}

function openOrIgnore(hook: Hook, dir: PositionDir): Decision {
  if (!hook.open.enabled) return { action: 'ignore', dir, reason: 'open module disabled' };
  return { action: 'open', dir, reason: `open ${dir}` };
}

function dcaOrIgnore(hook: Hook, dir: PositionDir): Decision {
  if (!hook.dca.enabled) return { action: 'ignore', dir, reason: 'averaging disabled' };
  return { action: 'dca', dir, reason: `average ${dir}` };
}

function closeOrIgnore(hook: Hook, dir: PositionDir, reason: string): Decision {
  if (!hook.close.enabled) return { action: 'ignore', dir, reason: 'close module disabled' };
  return { action: 'close', dir, reason };
}

function reverseOrClose(hook: Hook, dir: PositionDir, hedge: boolean): Decision {
  if (!hook.close.enabled) return { action: 'ignore', dir, reason: 'close module disabled' };
  // Reversal exists only in one-way futures mode (Finandy: "only available
  // for the Futures Market in one-way mode").
  if (hook.close.reverse && hook.market === 'futures' && !hedge) {
    return { action: 'reverse', dir, reason: `reverse ${dir} → ${opposite(dir)}` };
  }
  return { action: 'close', dir, reason: `close ${dir} on opposite signal` };
}
