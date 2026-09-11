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
 * on the signal's pair (one-way mode), if any.
 */
export function decide(hook: Hook, signal: Signal, position: ManagedPosition | undefined): Decision {
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
    return reverseOrClose(hook, position.side);
  }

  if (!position) {
    if (mode === 'long_only' && sigDir !== 'long') return { action: 'ignore', dir: sigDir, reason: 'long-only hook' };
    if (mode === 'short_only' && sigDir !== 'short') return { action: 'ignore', dir: sigDir, reason: 'short-only hook' };
    return openOrIgnore(hook, sigDir);
  }

  if (sigDir === position.side) return dcaOrIgnore(hook, position.side);

  // Opposite signal on an open position → close (or reverse, in "both" mode).
  if (mode === 'both') return reverseOrClose(hook, position.side);
  return closeOrIgnore(hook, position.side, `close ${position.side} on ${signal.side} signal`);
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

function reverseOrClose(hook: Hook, dir: PositionDir): Decision {
  if (!hook.close.enabled) return { action: 'ignore', dir, reason: 'close module disabled' };
  if (hook.close.reverse && hook.market === 'futures') {
    return { action: 'reverse', dir, reason: `reverse ${dir} → ${opposite(dir)}` };
  }
  return { action: 'close', dir, reason: `close ${dir} on opposite signal` };
}
