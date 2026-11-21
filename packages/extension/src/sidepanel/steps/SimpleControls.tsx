// Controls of the open / logout, instruction, capture and check steps.
import { useState } from 'react';
import { updateStep } from '@stubyard/client/walkthroughs';
import type { AssertResult } from '../../shared/protocol';
import { ErrorBox, useAction, usePanel } from '../context';
import { openUrl, samePage, sendToTab } from '../tabs';
import type { ResolvedOf, StepProps } from './StepCard';

/** Open: Go. Logout: Go to the logout URL, or an instruction when there is none. */
export function OpenControls({ resolved }: StepProps<ResolvedOf<'open' | 'logout'>>) {
  const p = usePanel();
  const act = useAction();
  const url = resolved.url;
  if (!url) return <p className="muted">Log out in the app, then press Done.</p>;
  const here = !!p.tab && samePage(p.tab.url, url);
  return (
    <div className="controls">
      <div className="muted small url">{url}</div>
      <button className="primary" disabled={!p.tab || !!act.busy} onClick={() => void act.run('go', () => openUrl(p.tab!.id, url))}>
        {here ? 'Reload' : 'Go'}
      </button>
      <ErrorBox error={act.error} />
    </div>
  );
}

export function InstructionControls({ step }: StepProps<ResolvedOf<'instruction'>>) {
  const p = usePanel();
  const act = useAction();
  if (!step.target) return null;
  return (
    <div className="controls">
      <button
        disabled={!p.tab || !!act.busy}
        onClick={() =>
          void act.run('highlight', async () => {
            const r = await sendToTab(p.tab!.id, { type: 'highlight', selector: step.target?.selector, text: step.target?.text });
            if (!r.found) throw new Error('The target is not on this page.');
          })
        }
      >
        Highlight
      </button>
      <ErrorBox error={act.error} />
    </div>
  );
}

/** Capture: read a value from the page → edit → Save (sets the walkthrough var). */
export function CaptureControls({ t, w, step, resolved, apply }: StepProps<ResolvedOf<'capture'>>) {
  const p = usePanel();
  const act = useAction();
  const saved = w.vars[resolved.var];
  const [value, setValue] = useState(saved ?? '');
  const [matched, setMatched] = useState<string | null>(null);

  return (
    <div className="controls">
      <div className="muted small">
        Saves <code>{`{{vars.${resolved.var}}}`}</code>
        {saved !== undefined && (
          <>
            {' '}
            (now <strong>{saved}</strong>)
          </>
        )}
        {resolved.required && ' · required'}
      </div>
      {(resolved.selector || resolved.textPattern) && (
        <button
          disabled={!p.tab || !!act.busy}
          onClick={() =>
            void act.run('capture', async () => {
              const r = await sendToTab(p.tab!.id, {
                type: 'capture',
                selector: resolved.selector ?? undefined,
                attribute: resolved.attribute ?? undefined,
                textPattern: resolved.textPattern ?? undefined,
              });
              if (r.error) throw new Error(r.error);
              if (r.value === null) throw new Error('Nothing matched on this page. Type the value instead.');
              setValue(r.value);
              setMatched(r.matchedText);
            })
          }
        >
          Capture
        </button>
      )}
      {matched && <div className="muted small">Found in: “{matched.length > 80 ? `${matched.slice(0, 79)}…` : matched}”</div>}
      <div className="row">
        <input value={value} placeholder="value" onChange={(e) => setValue(e.target.value)} />
        <button
          className="primary"
          disabled={!value.trim() || !!act.busy}
          onClick={() => void act.run('save', async () => apply(await updateStep(t, w.id, step.id, { value: value.trim() })))}
        >
          Save
        </button>
      </div>
      <ErrorBox error={act.error} />
    </div>
  );
}

/** Check: the expectation, an optional automatic assertion; Pass / Fail are the footer buttons. */
export function CheckControls({ t, w, step, resolved, apply }: StepProps<ResolvedOf<'check'>>) {
  const p = usePanel();
  const act = useAction();
  const [result, setResult] = useState<AssertResult | null>(null);
  const a = resolved.assert;
  return (
    <div className="controls">
      <p className="expect">
        <strong>Expect:</strong> {resolved.expect}
      </p>
      {a && (
        <>
          <button
            disabled={!p.tab || !!act.busy}
            onClick={() =>
              void act.run('assert', async () => {
                const r = await sendToTab(p.tab!.id, {
                  type: 'assert',
                  textPresent: a.textPresent ?? undefined,
                  selector: a.selector ?? undefined,
                  urlMatches: a.urlMatches ?? undefined,
                });
                setResult(r);
                apply(await updateStep(t, w.id, step.id, { data: { assertion: { present: r.ok, at: new Date().toISOString(), details: r.details } } }));
              })
            }
          >
            Run assertion
          </button>
          {result && (
            <div className={result.ok ? 'ok' : 'error'}>
              {result.ok ? 'Assertion passed' : 'Assertion failed'}
              <ul>
                {result.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}
