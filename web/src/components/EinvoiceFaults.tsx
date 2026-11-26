import { useState } from 'react';
import { useGate } from '../auth';
import { einvoiceApi, einvoiceBase, type DocType, type EinvoiceInstance, type EinvoiceReference, type EinvoiceRule, type FaultInput, type ZatcaEndpoint } from '../einvoiceApi';
import { useFetch } from '../hooks';
import { errText, plural, useEinvoiceFetch } from './EinvoiceShared';
import { RunChip } from './RunChip';
import { Badge, Empty, ErrorBox, timeAgo, useToast } from './ui';

/** Faults tab of the E-invoicing page: rules that make the fake Fatoora answer like the real gateway when something is wrong. */

const ENDPOINTS: ZatcaEndpoint[] = ['compliance', 'compliance_invoices', 'csids', 'csids_renew', 'reporting', 'clearance'];

interface Draft {
  kind: string;
  arg: string;
  instance: string;
  endpoint: ZatcaEndpoint | '';
  docType: DocType | '';
  number: string;
  times: string;
}

/** The argument a fault takes ("reject[:CODE]" → CODE), from the reference help text. */
function argOf(help: string | undefined): { name: string; required: boolean } | null {
  const m = help?.match(/(\[)?:(<?[A-Za-z]+>?)\]?$/);
  return m ? { name: m[2].replace(/[<>]/g, ''), required: !m[1] } : null;
}

export function EinvoiceFaults({ slug, inst, instances }: { slug: string; inst: EinvoiceInstance | null; instances: EinvoiceInstance[] }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  const ref = useFetch<EinvoiceReference>('/api/einvoice-reference');
  const list = useEinvoiceFetch<EinvoiceRule[]>(slug, `${einvoiceBase(slug)}/faults`);
  const [draft, setDraft] = useState<Draft>({ kind: 'reject', arg: '', instance: inst?.slug ?? '', endpoint: '', docType: '', number: '', times: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kinds = (ref.data?.faultKinds ?? []).filter((k) => k !== 'none');
  const helpOf = (kind: string) => ref.data?.faults.find((f) => f.fault.split(/[[:]/)[0] === kind);
  const help = helpOf(draft.kind);
  const arg = argOf(help?.fault);
  const add = async () => {
    setBusy(true);
    setError(null);
    const b: FaultInput = {
      fault: draft.arg.trim() ? `${draft.kind}:${draft.arg.trim()}` : draft.kind,
      instance: draft.instance || undefined,
      endpoint: draft.endpoint || undefined,
      docType: draft.docType || undefined,
      number: draft.number.trim() || undefined,
      times: draft.times ? Number(draft.times) : undefined,
    };
    try {
      await einvoiceApi.addFault(slug, b);
      toast('Fault added');
      setDraft({ ...draft, arg: '', number: '', times: '' });
      void list.reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: EinvoiceRule) => {
    try {
      await einvoiceApi.deleteFault(slug, r.id);
      void list.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const clear = async () => {
    if (!window.confirm('Delete every e-invoicing fault rule?')) return;
    try {
      const r = await einvoiceApi.clearFaults(slug);
      toast(`${plural(r.deleted, 'fault rule')} deleted`);
      void list.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const rows = (list.data ?? []).filter((r) => !inst || !r.instance || r.instance === inst.slug);
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <h3>Add a fault</h3>
        <p className="small muted">The next matching requests get the fault answer instead of the normal one. Leave a match field empty to match any value.</p>
        <ErrorBox error={error ?? ref.error} />
        <div className="form form-3">
          <label className="field">
            Fault
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value, arg: '' })}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          {arg && (
            <label className="field">
              {arg.name} <span className="hint">{arg.required ? 'required' : 'optional'}</span>
              <input value={draft.arg} onChange={(e) => setDraft({ ...draft, arg: e.target.value })} placeholder={arg.name === 'CODE' ? 'BR-KSA-26' : arg.name} />
            </label>
          )}
          <label className="field">
            Instance
            <select value={draft.instance} onChange={(e) => setDraft({ ...draft, instance: e.target.value })}>
              <option value="">Any instance</option>
              {instances.map((i) => (
                <option key={i.id} value={i.slug}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Endpoint
            <select value={draft.endpoint} onChange={(e) => setDraft({ ...draft, endpoint: e.target.value as ZatcaEndpoint | '' })}>
              <option value="">Any endpoint</option>
              {ENDPOINTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Invoice type
            <select value={draft.docType} onChange={(e) => setDraft({ ...draft, docType: e.target.value as DocType | '' })}>
              <option value="">Any type</option>
              <option value="standard">standard</option>
              <option value="simplified">simplified</option>
            </select>
          </label>
          <label className="field">
            Invoice number
            <input value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} placeholder="any" />
          </label>
          <label className="field">
            Times <span className="hint">empty = every request</span>
            <input type="number" min={1} value={draft.times} onChange={(e) => setDraft({ ...draft, times: e.target.value })} placeholder="every" />
          </label>
        </div>
        {help && (
          <p className="small muted">
            <code>{help.fault}</code>: {help.answer}
          </p>
        )}
        <div className="row">
          <button className="btn primary" onClick={() => void add()} disabled={busy || !draft.kind || (!!arg?.required && !draft.arg.trim()) || !!gate.disabled} title={gate.title}>
            Add fault
          </button>
        </div>
      </div>
      <ErrorBox error={list.error} />
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{plural(rows.length, 'fault rule')}</h3>
          <button className="btn sm ghost" onClick={() => void clear()} disabled={!list.data?.length || !!gate.disabled} title={gate.title}>
            Clear all
          </button>
        </div>
        {!list.data ? (
          <p className="card-pad muted">Loading…</p>
        ) : !rows.length ? (
          <Empty title="No faults">
            <p className="small muted">Every request gets the normal answer. Tests can also send the X-Hub-Scenario header for one request.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="einv-table">
              <caption className="sr-only">E-invoicing fault rules</caption>
              <thead>
                <tr>
                  <th scope="col">Fault</th>
                  <th scope="col">Matches</th>
                  <th scope="col">Left / hits</th>
                  <th scope="col">Added</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const match = [r.instance && `instance ${r.instance}`, r.match.endpoint, r.match.docType, r.match.number && `number ${r.match.number}`, r.match.seller && `seller ${r.match.seller}`, r.match.csid && `CSID ${r.match.csid}`].filter(Boolean);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Badge kind="accent">{r.fault}</Badge>
                        {r.run && (
                          <div>
                            <RunChip runKey={r.run} />
                          </div>
                        )}
                      </td>
                      <td className="small">{match.length ? match.join(' · ') : <span className="faint">every request</span>}</td>
                      <td className="small">
                        {r.remaining ?? 'always'} / {r.hits}
                      </td>
                      <td className="small faint nowrap">{timeAgo(r.createdAt)}</td>
                      <td>
                        <button className="btn xs ghost" onClick={() => void remove(r)} aria-label={`Delete fault ${r.fault}`} {...gate}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
