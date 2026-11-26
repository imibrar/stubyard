import type { ReactNode } from 'react';
import { useDebounced, useFetch, useHubEvents } from '../hooks';
import { STATUS_KIND, type EinvoiceLintFinding, type EinvoiceStatus, type ValidationMessage, type ValidationResults } from '../einvoiceApi';
import { Icon, type IconName } from './people';
import { Badge, Empty } from './ui';

/** Pieces shared by the E-invoicing page (pages/EinvoicePage.tsx) and its Checks / Faults / Connect tabs. */

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const LINT_KIND: Record<EinvoiceLintFinding['severity'], string> = { error: 'bad', warn: 'warn', info: '' };
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** useFetch that reloads on einvoice.changed and project.reset. */
export function useEinvoiceFetch<T>(slug: string, path: string | null) {
  const f = useFetch<T>(path, [slug]);
  const reload = useDebounced(() => void f.reload(), 250);
  useHubEvents(slug, (e) => {
    if (e.type === 'einvoice.changed' || e.type === 'project.reset') reload();
  });
  return f;
}

const STATUS_ICON: Record<string, IconName> = { ok: 'check', bad: 'close', warn: 'info', accent: 'flag' };

/** Invoice status with an icon and the status text (never colour alone). */
export function InvoiceStatus({ status, title }: { status: EinvoiceStatus; title?: string }) {
  const kind = STATUS_KIND[status] ?? '';
  return (
    <Badge kind={kind} title={title}>
      <span className="einv-status">
        <Icon name={STATUS_ICON[kind] ?? 'info'} size={12} />
        {status.replace(/_/g, ' ')}
      </span>
    </Badge>
  );
}

/** Errors and warnings of the ZATCA validationResults (info messages last). */
export function ValidationTable({ results, caption }: { results: ValidationResults; caption: string }) {
  const rows: ValidationMessage[] = [...results.errorMessages, ...results.warningMessages, ...results.infoMessages];
  if (!rows.length) return <p className="small muted">No validation messages: every check passed.</p>;
  return (
    <div className="table-wrap">
      <table className="einv-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Code</th>
            <th scope="col">Category</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => (
            <tr key={i}>
              <td>
                <Badge kind={m.type === 'ERROR' ? 'bad' : m.type === 'WARNING' ? 'warn' : ''}>{m.type.toLowerCase()}</Badge>
              </td>
              <td>
                <code className="small einv-code">{m.code}</code>
              </td>
              <td className="small">{m.category}</td>
              <td className="small einv-msg">{m.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Integration-check findings (stubyard lint): severity, check, message and the XML path when there is one. */
export function LintTable({ findings, caption, where }: { findings: (EinvoiceLintFinding & { where?: ReactNode })[]; caption: string; where?: boolean }) {
  if (!findings.length)
    return (
      <Empty title="No integration problems">
        <p className="small muted">No lint findings.</p>
      </Empty>
    );
  return (
    <div className="table-wrap">
      <table className="einv-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Severity</th>
            <th scope="col">Check</th>
            <th scope="col">Message</th>
            <th scope="col">{where ? 'Where' : 'Path'}</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f, i) => (
            <tr key={i}>
              <td>
                <Badge kind={LINT_KIND[f.severity]}>{f.severity}</Badge>
              </td>
              <td>
                <code className="small einv-code">{f.check}</code>
              </td>
              <td className="small einv-msg">{f.message}</td>
              <td className="small">{where ? f.where : f.path ? <code className="einv-cut">{f.path}</code> : <span className="faint">none</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Save text as a file (sample XML, base64 body). */
export function downloadText(name: string, text: string, type = 'application/xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
