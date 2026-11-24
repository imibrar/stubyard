import { useState } from 'react';
import { createSchedule, type ScheduledRequest } from '../schedulesApi';
import { useGate } from '../auth';
import { useProject } from '../context';
import { Menu } from './people';
import { ErrorBox, Modal, fmtTime, useToast } from './ui';
import '../styles/scheduled.css';

const PRESETS: [string, number][] = [
  ['In 10 seconds', 10_000],
  ['In 1 minute', 60_000],
  ['In 5 minutes', 300_000],
];
const UNITS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000 };

/**
 * "Later ▾" split-button menu next to a "Send now" / "Run" button: schedules the same REST call for later
 * (10 s, 1 min, 5 min, or a custom delay with an optional repeat). `request` is read when a choice is made, so
 * the current form values are used; throw from it to show a validation error.
 */
export function SendLater({ request, label, run, disabled, className }: { request: () => ScheduledRequest; label?: string; run?: string | null; disabled?: boolean; className?: string }) {
  const { slug } = useProject();
  const gate = useGate(slug)('project.providers');
  const toast = useToast();
  const [custom, setCustom] = useState(false);

  const schedule = async (delayMs: number, extra: { everyMs?: number | null; maxFires?: number; label?: string } = {}) => {
    const req = request();
    const s = await createSchedule(slug, req, { delayMs, run, label: extra.label ?? label, everyMs: extra.everyMs, maxFires: extra.maxFires });
    toast(`Scheduled for ${s.nextAt ? fmtTime(s.nextAt) : 'later'}${s.everyMs ? ` · ${s.maxFires}×` : ''} — see Scheduled`);
  };
  const quick = async (ms: number) => {
    try {
      await schedule(ms);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <span className="send-later">
      {disabled || gate.disabled ? (
        <button className={className ?? 'btn sm'} disabled title={gate.title}>
          Later ▾
        </button>
      ) : (
        <Menu floating label={<span title="Schedule this for later">Later ▾</span>} className={className ?? 'btn sm'}>
          {(close) => (
            <>
              {PRESETS.map(([text, ms]) => (
                <button key={ms} type="button" role="menuitem" onClick={() => (close(), void quick(ms))}>
                  {text}
                </button>
              ))}
              <button type="button" role="menuitem" onClick={() => (close(), setCustom(true))}>
                Custom… <span className="sub">repeat</span>
              </button>
            </>
          )}
        </Menu>
      )}
      {custom && <CustomModal defaultLabel={label ?? ''} onClose={() => setCustom(false)} onSubmit={schedule} />}
    </span>
  );
}

function CustomModal({ defaultLabel, onClose, onSubmit }: { defaultLabel: string; onClose: () => void; onSubmit: (delayMs: number, extra: { everyMs?: number | null; maxFires?: number; label?: string }) => Promise<void> }) {
  const [amount, setAmount] = useState('30');
  const [unit, setUnit] = useState('seconds');
  const [repeat, setRepeat] = useState(false);
  const [every, setEvery] = useState('60');
  const [everyUnit, setEveryUnit] = useState('seconds');
  const [times, setTimes] = useState('5');
  const [label, setLabel] = useState(defaultLabel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const delayMs = Math.round(Number(amount) * UNITS[unit]);
      if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Enter a delay of 0 or more');
      const everyMs = repeat ? Math.round(Number(every) * UNITS[everyUnit]) : null;
      if (repeat && !(everyMs! >= 1000)) throw new Error('Repeat at least every 1 second');
      await onSubmit(delayMs, { everyMs, maxFires: repeat ? Number(times) : undefined, label: label.trim() || undefined });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Schedule for later"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            Schedule
          </button>
        </>
      }
    >
      {/* A div, not a form: the button can sit inside another form (the reply bar). */}
      <div className="form" onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.preventDefault(), void submit())}>
        <ErrorBox error={error} />
        <div className="form form-2">
          <label className="field">
            Fire in
            <input type="number" min={0} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="field">
            Unit
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {Object.keys(UNITS).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="row small">
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repeat
        </label>
        {repeat && (
          <div className="form form-3">
            <label className="field">
              Every
              <input type="number" min={1} inputMode="decimal" value={every} onChange={(e) => setEvery(e.target.value)} />
            </label>
            <label className="field">
              Unit
              <select value={everyUnit} onChange={(e) => setEveryUnit(e.target.value)}>
                {Object.keys(UNITS).map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Times <span className="hint">max 100</span>
              <input type="number" min={1} max={100} value={times} onChange={(e) => setTimes(e.target.value)} />
            </label>
          </div>
        )}
        <label className="field">
          Label <span className="hint">optional</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. payment succeeded after 30 s" />
        </label>
        <p className="small faint" style={{ margin: 0 }}>
          Max 30 days ahead. Scheduled actions are listed under Scheduled, where they can be run now, paused, edited or cancelled.
        </p>
      </div>
    </Modal>
  );
}
