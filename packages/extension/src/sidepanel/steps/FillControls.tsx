// Fill step: Open page, Fill form (the hub rendered the entries; the content script fills visible fields only),
// and the report (also kept in the step's data, so it is still shown after the panel was closed).
import { useEffect, useRef, useState } from 'react';
import { updateStep } from '@stubyard/client/walkthroughs';
import type { FillReport } from '../../shared/protocol';
import { ErrorBox, useAction } from '../context';
import { useStepHost } from '../../run/host';
import { OriginPrompt, useOriginGuard } from '../../run/originGuard';
import { pageOrigin } from '../../shared/settings';
import { fillSummary } from '../state';
import { openUrl, samePage, sendToTab } from '../tabs';
import type { ResolvedOf, StepProps } from './StepCard';

const asReport = (d: Record<string, unknown>): FillReport | null =>
  typeof d.filled === 'number' && Array.isArray(d.details) ? (d as unknown as FillReport) : null;

export function FillControls({ t, w, step, resolved, apply }: StepProps<ResolvedOf<'fill'>>) {
  const p = useStepHost();
  const act = useAction();
  const [report, setReport] = useState<FillReport | null>(() => asReport(step.data));
  const url = resolved.url;
  const here = !!url && !!p.tab && samePage(p.tab.url, url);
  const g = useOriginGuard();

  const doFill = () =>
    act.run('fill', async () => {
      if (!p.tab) throw new Error('No tab to fill.');
      // The content script fills only while the page is still on the origin checked here.
      const origin = pageOrigin(p.tab.url) ?? undefined;
      const r = await sendToTab(p.tab.id, { type: 'fill', entries: resolved.entries, formId: resolved.formId, overwrite: true, ...(origin ? { origin } : {}) });
      setReport(r);
      apply(await updateStep(t, w.id, step.id, { data: { filled: r.filled, unmatched: r.unmatched, skipped: r.skipped, errors: r.errors, details: r.details } }));
    });
  const fill = () => g.guard(() => void doFill());

  // Alt+Shift+F (relayed by the service worker) fills while this step is open.
  const first = useRef(p.fillRequest);
  useEffect(() => {
    if (p.fillRequest !== first.current) void fill();
  }, [p.fillRequest]);

  return (
    <div className="controls">
      <div className="muted small">
        Data set <strong>{resolved.dataSet.name}</strong> · {resolved.entries.length} values{resolved.formId ? ` · form ${resolved.formId}` : ''}
      </div>
      <div className="row wrap">
        {url && !here && (
          <button disabled={!p.tab || !!act.busy} onClick={() => void act.run('open', () => openUrl(p.tab!.id, url))}>
            Open page
          </button>
        )}
        <button className="primary" disabled={!p.tab || !!act.busy} onClick={() => void fill()}>
          {act.busy === 'fill' ? 'Filling…' : 'Fill form'}
        </button>
      </div>
      <OriginPrompt g={g} what="the form" />
      <p className="muted small">Fill this step, check it, click Next yourself, then press Fill again. Shortcut: Alt+Shift+F.</p>
      {report && (
        <details className="report">
          <summary>{fillSummary(report)}</summary>
          <ul>
            {report.details.map((d) => (
              <li key={d.key} className={d.status}>
                <code>{d.key}</code> {d.status}
                {d.matchedBy ? ` (by ${d.matchedBy})` : ''}
                {d.reason ? `: ${d.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}
