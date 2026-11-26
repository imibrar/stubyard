import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useGate } from '../auth';
import {
  einvoiceApi,
  einvoiceBase,
  type DocType,
  type EinvoiceInstance,
  type EinvoiceLintReport,
  type EinvoiceReference,
  type EinvoiceSample,
  type EinvoiceValidateResult,
  type ZatcaEndpoint,
} from '../einvoiceApi';
import { useFetch } from '../hooks';
import { downloadText, errText, LINT_KIND, LintTable, plural, useEinvoiceFetch, ValidationTable } from './EinvoiceShared';
import { Badge, CodeBlock, Empty, ErrorBox, useCopy } from './ui';

/** Checks tab of the E-invoicing page: integration-check findings, "Validate XML", sample invoices and the rule catalog. */

export function EinvoiceChecks({ slug, inst }: { slug: string; inst: EinvoiceInstance }) {
  const ref = useFetch<EinvoiceReference>('/api/einvoice-reference');
  return (
    <div className="stack">
      <LintPanel slug={slug} />
      <div className="einv-grid">
        <ValidateForm slug={slug} inst={inst} />
        <SampleForm slug={slug} inst={inst} reference={ref.data} />
      </div>
      <ErrorBox error={ref.error} />
      {ref.data && <RuleCatalog reference={ref.data} />}
    </div>
  );
}

function LintPanel({ slug }: { slug: string }) {
  const r = useEinvoiceFetch<EinvoiceLintReport>(slug, `${einvoiceBase(slug)}/lint`);
  const rep = r.data;
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">{rep ? `${plural(rep.findings.length, 'integration finding')} in ${plural(rep.invoices, 'invoice')}` : 'Integration checks'}</h3>
        {rep && (
          <div className="row einv-chips">
            {(['error', 'warn', 'info'] as const).map((s) =>
              rep.counts[s] ? (
                <Badge key={s} kind={LINT_KIND[s]}>
                  {rep.counts[s]} {s}
                </Badge>
              ) : null,
            )}
          </div>
        )}
      </div>
      <ErrorBox error={r.error} />
      {!rep ? (
        !r.error && <p className="card-pad muted">Loading…</p>
      ) : (
        <LintTable
          caption="Integration check findings of the project"
          where
          findings={rep.findings.map((f) => ({ ...f, where: f.invoice ? `invoice ${f.number ?? f.invoice}` : f.csid ? 'CSID' : (f.instance ?? '') }))}
        />
      )}
    </div>
  );
}

function ValidateForm({ slug, inst }: { slug: string; inst: EinvoiceInstance }) {
  const [xml, setXml] = useState('');
  const [endpoint, setEndpoint] = useState<ZatcaEndpoint>('reporting');
  const [res, setRes] = useState<EinvoiceValidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await einvoiceApi.validate(slug, { xml: xml.trim(), endpoint, instance: inst.slug }));
    } catch (e) {
      setError(errText(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card card-pad stack">
      <h3>Validate XML</h3>
      <p className="small muted">Paste an invoice (XML text or the base64 of the ZATCA body). Nothing is stored and no chain moves.</p>
      <label className="field">
        Invoice
        <textarea className="einv-xml-input" value={xml} onChange={(e) => setXml(e.target.value)} rows={8} placeholder="<Invoice xmlns=…> or PD94bWwg…" spellCheck={false} />
      </label>
      <div className="row">
        <label className="row nowrap">
          <span className="small muted">Endpoint</span>
          <select value={endpoint} onChange={(e) => setEndpoint(e.target.value as ZatcaEndpoint)}>
            <option value="reporting">reporting (simplified)</option>
            <option value="clearance">clearance (standard)</option>
            <option value="compliance_invoices">compliance check</option>
          </select>
        </label>
        <button className="btn primary" onClick={() => void run()} disabled={busy || !xml.trim()}>
          Validate
        </button>
      </div>
      <ErrorBox error={error} />
      {res && (
        <div className="stack" aria-live="polite">
          <div className="row einv-chips">
            <Badge kind={res.status === 'PASS' ? 'ok' : res.status === 'WARNING' ? 'warn' : 'bad'}>{res.status}</Badge>
            <span className="small faint">
              checks {res.checks}
              {res.instance ? ` · ${res.instance}` : ''}
            </span>
          </div>
          <ValidationTable results={res.validationResults} caption="Validation messages of the pasted invoice" />
          {res.lint.length > 0 && <LintTable findings={res.lint} caption="Integration check findings of the pasted invoice" />}
        </div>
      )}
    </div>
  );
}

function SampleForm({ slug, inst, reference }: { slug: string; inst: EinvoiceInstance; reference: EinvoiceReference | null }) {
  const gate = useGate(slug)('walkthroughs.run');
  const copy = useCopy();
  const [type, setType] = useState<DocType>('simplified');
  const [kind, setKind] = useState<'388' | '381' | '383'>('388');
  const [brk, setBrk] = useState('');
  const [icv, setIcv] = useState('1');
  const [res, setRes] = useState<EinvoiceSample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setRes(await einvoiceApi.sample(slug, { instance: inst.slug, type, kind, break: brk || undefined, icv: icv ? Number(icv) : undefined }));
    } catch (e) {
      setError(errText(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  };
  const breakInfo = reference?.breaks.find((b) => b.name === brk);
  const body = res ? JSON.stringify({ invoiceHash: res.invoiceHash, uuid: res.uuid, invoice: res.invoice }, null, 2) : '';
  return (
    <div className="card card-pad stack">
      <h3>Sample invoice</h3>
      <p className="small muted">A signed sample from the demo EGS of {inst.name}, optionally broken on purpose to see the matching ZATCA error.</p>
      <div className="form form-2">
        <label className="field">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as DocType)}>
            <option value="simplified">simplified (B2C, reporting)</option>
            <option value="standard">standard (B2B, clearance)</option>
          </select>
        </label>
        <label className="field">
          Subtype
          <select value={kind} onChange={(e) => setKind(e.target.value as '388' | '381' | '383')}>
            <option value="388">388 invoice</option>
            <option value="381">381 credit note</option>
            <option value="383">383 debit note</option>
          </select>
        </label>
        <label className="field">
          Break <span className="hint">none = a valid invoice</span>
          <select value={brk} onChange={(e) => setBrk(e.target.value)}>
            <option value="">none</option>
            {(reference?.breaks ?? []).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} ({b.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          ICV
          <input type="number" min={1} value={icv} onChange={(e) => setIcv(e.target.value)} />
        </label>
      </div>
      {breakInfo && <p className="small muted">{breakInfo.description}</p>}
      <div className="row">
        <button className="btn primary" onClick={() => void make()} disabled={busy || !!gate.disabled} title={gate.title}>
          Make sample
        </button>
      </div>
      <ErrorBox error={error} />
      {res && (
        <div className="stack">
          <div className="row einv-chips">
            <button className="btn sm" onClick={() => downloadText(`sample-${res.type}-${res.kind}${res.breaks.length ? `-${res.breaks.join('-')}` : ''}.xml`, res.xml)}>
              Download XML
            </button>
            <button className="btn sm ghost" onClick={() => void copy(body, 'Request body copied')}>
              Copy request body
            </button>
          </div>
          <p className="small muted">
            Send it to <code className="einv-cut">{res.endpoint}</code> with Basic auth of the demo CSID (token and secret below).
          </p>
          <CodeBlock title="Request body" lang="json" code={body} />
          <CodeBlock title="Basic auth" code={`binarySecurityToken: ${res.auth.binarySecurityToken}\nsecret: ${res.auth.secret}`} />
          {res.expect !== undefined && res.expect !== null && <CodeBlock title="Expected answer" lang="json" code={JSON.stringify(res.expect, null, 2)} />}
          <CodeBlock title="Invoice XML" lang="markup" code={res.xml} wrap={false} />
        </div>
      )}
    </div>
  );
}

function RuleCatalog({ reference }: { reference: EinvoiceReference }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const rules = needle ? reference.rules.filter((r) => `${r.code} ${r.category} ${r.message}`.toLowerCase().includes(needle)) : reference.rules;
  const lint = needle ? reference.lint.filter((l) => `${l.id} ${l.label} ${l.description}`.toLowerCase().includes(needle)) : reference.lint;
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="grow">Rule catalog</h3>
        <input type="search" className="einv-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code, category or text" aria-label="Search rules" />
      </div>
      {!rules.length && !lint.length ? (
        <Empty title="No matching rules" />
      ) : (
        <div className="stack">
          {rules.length > 0 && (
            <div className="table-wrap">
              <table className="einv-table">
                <caption className="einv-caption">
                  ZATCA validation rules ({rules.length}
                  {needle ? ` of ${reference.rules.length}` : ''})
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Category</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.code}>
                      <td className="nowrap">
                        <code className="small einv-code">{r.code}</code>
                        {!r.verified && (
                          <div>
                            <Badge title="Wording not verified against the ZATCA SDK">unverified</Badge>
                          </div>
                        )}
                      </td>
                      <td className="small">{r.category}</td>
                      <td>
                        <Badge kind={r.severity.toLowerCase().startsWith('err') ? 'bad' : r.severity.toLowerCase().startsWith('warn') ? 'warn' : ''}>{r.severity.toLowerCase()}</Badge>
                      </td>
                      <td className="small einv-msg">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lint.length > 0 && (
            <div className="table-wrap">
              <table className="einv-table">
                <caption className="einv-caption">stubyard integration checks ({lint.length})</caption>
                <thead>
                  <tr>
                    <th scope="col">Check</th>
                    <th scope="col">Severity</th>
                    <th scope="col">What it finds</th>
                  </tr>
                </thead>
                <tbody>
                  {lint.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <code className="small einv-code">{l.id}</code>
                      </td>
                      <td>
                        <Badge kind={LINT_KIND[l.severity]}>{l.severity}</Badge>
                      </td>
                      <td className="small einv-msg">
                        <strong>{l.label}</strong> {l.description}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <p className="card-pad small faint">
        Faults that force these answers are on the <Link to="?tab=faults">Faults</Link> tab.
      </p>
    </div>
  );
}
