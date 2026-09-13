import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { ManagedPosition, TpOrderSpec } from '../types';
import { NumberInput } from './NumberInput';

const CANDLE_TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d', '1w'];

export interface ManageTarget {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entryPrice: number;
  /** The managed record, when editing protection on an already-managed one. */
  existing?: ManagedPosition;
}

/**
 * Attach (or replace) a TP grid + SL/trailing on a position that already exists
 * on the exchange. Mirrors the order panel's protection modules but targets a
 * live position instead of a new order.
 */
export function ManagePositionDialog({ target, onClose }: { target: ManageTarget; onClose: () => void }) {
  const { market, setError, loadAccountState } = useStore();
  const account = useStore((s) => s.account());
  const cfg = target.existing?.config;

  const [tpOn, setTpOn] = useState(cfg?.tp.enabled ?? true);
  const [tpOrders, setTpOrders] = useState<TpOrderSpec[]>(
    cfg?.tp.orders?.length ? cfg.tp.orders : [{ ofsPct: 1, price: 0, piecePct: 100 }],
  );
  const [slOn, setSlOn] = useState(cfg?.sl.enabled ?? false);
  const [slOfs, setSlOfs] = useState(cfg?.sl.ofsPct ?? 3);
  const [slPrice, setSlPrice] = useState<number | undefined>((cfg?.sl.price ?? 0) > 0 ? cfg?.sl.price : undefined);
  const [slTrig, setSlTrig] = useState(cfg?.sl.trigger === 'candle' ? cfg?.sl.candleTf ?? '1m' : 'price');
  const [beTp, setBeTp] = useState(cfg?.sl.breakevenAfterTp ?? 0);
  const [slxOn, setSlxOn] = useState(cfg?.slx.enabled ?? false);
  const [slxAct, setSlxAct] = useState(cfg?.slx.activationOfsPct ?? 1);
  const [slxTrail, setSlxTrail] = useState(cfg?.slx.trailPct ?? 0.5);
  const [slxTrig, setSlxTrig] = useState(cfg?.slx.trigger === 'candle' ? cfg?.slx.candleTf ?? '1m' : 'price');
  const [busy, setBusy] = useState(false);

  const setTp = (i: number, patch: Partial<TpOrderSpec>) =>
    setTpOrders((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  const dirSign = target.side === 'long' ? 1 : -1;
  const preview = (ofsPct: number, price: number) =>
    price > 0 ? price : target.entryPrice * (1 + (dirSign * ofsPct) / 100);

  const apply = async () => {
    setBusy(true);
    try {
      const detail = await api.managePosition({
        accountId: account,
        market,
        symbol: target.symbol,
        side: target.side,
        tp: tpOn
          ? { enabled: true, orderType: 'limit', orders: tpOrders, reorderLevels: true, updateBySignal: false }
          : { enabled: false, orderType: 'limit', orders: [], reorderLevels: true, updateBySignal: false },
        sl:
          slOn || beTp > 0
            ? {
                enabled: slOn,
                ofsPct: slOfs,
                price: slPrice || 0,
                orderType: 'stop_market',
                reorderAfterDca: true,
                breakevenAfterTp: beTp,
                trigger: slTrig === 'price' ? 'price' : 'candle',
                candleTf: slTrig === 'price' ? '1m' : slTrig,
              }
            : { enabled: false, ofsPct: slOfs, price: 0, orderType: 'stop_market', reorderAfterDca: true, breakevenAfterTp: 0 },
        slx: slxOn
          ? {
              enabled: true,
              activationOfsPct: slxAct,
              trailPct: slxTrail,
              trigger: slxTrig === 'price' ? 'price' : 'candle',
              candleTf: slxTrig === 'price' ? '1m' : slxTrig,
            }
          : { enabled: false, activationOfsPct: slxAct, trailPct: slxTrail },
      });
      setError(null);
      await loadAccountState();
      onClose();
      // eslint-disable-next-line no-console
      console.log('manage position:', detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-title" style={{ padding: 0 }}>
          {target.existing ? 'Edit protection' : 'Manage position'}
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>
            {target.symbol}{' '}
            <span className={target.side === 'long' ? 'pos' : 'neg'}>{target.side}</span>
          </strong>
          <span className="dim mono">
            {target.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })} @{' '}
            {target.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 8 })}
          </span>
        </div>

        <div className="module">
          <div className="module-head" onClick={() => setTpOn(!tpOn)}>
            <input type="checkbox" checked={tpOn} readOnly /> Take Profit (TP)
          </div>
          {tpOn && (
            <>
              {tpOrders.map((o, i) => (
                <div className="row" key={i}>
                  <span className="dim">TP{i + 1}</span>
                  <NumberInput value={o.ofsPct} disabled={o.price > 0} title="offset %" onChange={(v) => setTp(i, { ofsPct: v ?? 0 })} />
                  <span className="dim">% or</span>
                  <NumberInput allowEmpty placeholder="price" title="Absolute price; overrides % when set" value={o.price} onChange={(v) => setTp(i, { price: v ?? 0 })} />
                  <NumberInput value={o.piecePct} onChange={(v) => setTp(i, { piecePct: v ?? 0 })} />
                  <span className="dim">% qty</span>
                  <span className="dim mono">→ {preview(o.ofsPct, o.price).toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>
                  {tpOrders.length > 1 && (
                    <button className="ghost" onClick={() => setTpOrders(tpOrders.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                className="ghost"
                onClick={() => {
                  const even = Math.floor(100 / (tpOrders.length + 1));
                  setTpOrders([
                    ...tpOrders.map((o) => ({ ...o, piecePct: even })),
                    { ofsPct: (tpOrders.at(-1)?.ofsPct ?? 1) + 1, price: 0, piecePct: 100 - even * tpOrders.length },
                  ]);
                }}
              >
                + level
              </button>
            </>
          )}
        </div>

        <div className="module">
          <div className="module-head" onClick={() => setSlOn(!slOn)}>
            <input type="checkbox" checked={slOn} readOnly /> Stop Loss (SL)
          </div>
          {slOn && (
            <div className="row">
              <label>Offset %</label>
              <NumberInput value={slOfs} disabled={(slPrice ?? 0) > 0} onChange={(v) => setSlOfs(v ?? 0)} />
              <span className="dim">or</span>
              <NumberInput allowEmpty placeholder="price" title="Absolute stop price; overrides % when set" value={slPrice} onChange={setSlPrice} />
              <select
                title="Price touch fires instantly; a candle option fires only when that candle closes beyond the level (server must be running)"
                value={slTrig}
                onChange={(e) => setSlTrig(e.target.value)}
              >
                <option value="price">Touch</option>
                {CANDLE_TFS.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf} close
                  </option>
                ))}
              </select>
              <span className="dim mono">→ {preview(-slOfs, slPrice ?? 0).toLocaleString(undefined, { maximumFractionDigits: 8 })}</span>
            </div>
          )}
          <div className="row">
            <label title="Move the stop to break-even (entry) after this many TPs fill. Works even with SL and Trailing off (0 = off).">
              Breakeven after TP#
            </label>
            <NumberInput integer value={beTp} onChange={(v) => setBeTp(v ?? 0)} />
            <span className="dim" style={{ fontSize: 12 }}>
              0 = off
            </span>
          </div>
        </div>

        <div className="module">
          <div className="module-head" onClick={() => setSlxOn(!slxOn)}>
            <input type="checkbox" checked={slxOn} readOnly /> Trailing (SLX)
          </div>
          {slxOn && (
            <>
              <div className="row">
                <label>Activate %</label>
                <NumberInput value={slxAct} onChange={(v) => setSlxAct(v ?? 0)} />
              </div>
              <div className="row">
                <label>Trail %</label>
                <NumberInput value={slxTrail} onChange={(v) => setSlxTrail(v ?? 0)} />
              </div>
              <div className="row">
                <label>Trigger</label>
                <select value={slxTrig} onChange={(e) => setSlxTrig(e.target.value)}>
                  <option value="price">Touch</option>
                  {CANDLE_TFS.map((tf) => (
                    <option key={tf} value={tf}>
                      {tf} close
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        <div className="dim" style={{ fontSize: 12 }}>
          TP/SL sizes track the position's current quantity. Existing terminal-placed TP/SL on this
          position are replaced.
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy} onClick={() => void apply()}>
            {busy ? '…' : target.existing ? 'Update protection' : 'Manage position'}
          </button>
        </div>
      </div>
    </div>
  );
}
