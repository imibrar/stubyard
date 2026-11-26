import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useGate } from '../auth';
import { EinvoiceChecks } from '../components/EinvoiceChecks';
import { EinvoiceConnectTab } from '../components/EinvoiceConnect';
import { EinvoiceFaults } from '../components/EinvoiceFaults';
import { useEinvoiceInstances } from '../components/EinvoiceProviders';
import { errText, InvoiceStatus, LintTable, plural, useEinvoiceFetch, ValidationTable } from '../components/EinvoiceShared';
import { KeyValue, Tabs, type KV } from '../components/layout';
import { Icon } from '../components/people';
import { providersPath } from '../components/providerLayout';
import { RunChip } from '../components/RunChip';
import { LogDrawer } from '../components/TrafficLog';
import { Badge, CodeBlock, Drawer, Empty, ErrorBox, fmtDateTime, timeAgo, timeUntil, useTick, useToast } from '../components/ui';
import { useProject } from '../context';
import {
  einvoiceApi,
  einvoiceBase,
  invoiceXmlUrl,
  ZATCA_ENV_LABEL,
  type DocKind,
  type Einvoice,
  type EinvoiceChain,
  type EinvoiceCsid,
  type EinvoiceDetail,
  type EinvoiceInstance,
  type EinvoiceOtp,
  type EinvoiceStatus,
  type ZatcaEndpoint,
} from '../einvoiceApi';
import { qs } from '../api';
import { EINVOICE_TABS, resolveTab } from '../nav';
import { Page } from './ProjectPage';
import '../styles/einvoice.css';

/** /p/:slug/einvoice — fake ZATCA invoices, onboarding (CSIDs), ICV / PIH chains, faults, checks and connect. */

type Tab = 'invoices' | 'onboarding' | 'chains' | 'faults' | 'checks' | 'connect';

export default function EinvoicePage() {
  const { slug } = useProject();
  const [params, setParams] = useSearchParams();
  const tab = resolveTab(EINVOICE_TABS, params.get('tab')).id as Tab;
  const d = useEinvoiceInstances(slug);
  const list = d.overview?.instances ?? [];
  // '' = every instance; an unknown slug falls back to every instance too.
  const inst = list.find((i) => i.slug === params.get('instance')) ?? null;
  const setParam = (k: string, v: string, def = '') =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v && v !== def) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  const ov = d.overview;
  return (
    <Page
      title="E-invoicing"
      description="Fake ZATCA Fatoora: invoices your EGS reported or cleared, CSIDs and compliance checks, ICV / PIH chains, faults and integration checks."
      actions={
        <Link className="btn" to={providersPath(slug, 'einvoice', inst?.slug)}>
          <Icon name="plug" size={14} /> ZATCA instances
        </Link>
      }
    >
      <ErrorBox error={d.error} />
      {!ov ? (
        !d.error && <p className="muted">Loading…</p>
      ) : !list.length ? (
        <div className="card">
          <Empty title="No ZATCA instances yet">
            <p className="small muted">Add a fake ZATCA Fatoora instance in Providers, point your EGS or SDK base URL at it, then onboard and report invoices.</p>
            <Link className="btn primary" to={providersPath(slug, 'einvoice')}>
              Add a ZATCA instance
            </Link>
          </Empty>
        </div>
      ) : (
        <>
          <div className="einv-bar">
            <label className="row nowrap einv-picker">
              <span className="small muted">Instance</span>
              <select value={inst?.slug ?? ''} onChange={(e) => setParam('instance', e.target.value)} aria-label="ZATCA instance">
                {list.length > 1 && <option value="">All instances</option>}
                {list.map((i) => (
                  <option key={i.id} value={i.slug}>
                    {i.name} ({ZATCA_ENV_LABEL[i.config.env]})
                  </option>
                ))}
              </select>
            </label>
            <div className="row einv-chips">
              {(inst ?? (list.length === 1 ? list[0] : null))?.enabled === false && <Badge kind="bad">disabled</Badge>}
              <Badge title="Active CSIDs (compliance / production)">
                {plural(ov.csids.active, 'active CSID')} ({ov.csids.compliance} compliance, {ov.csids.production} production)
              </Badge>
              <Badge>{plural(ov.chains, 'chain')}</Badge>
              {ov.faults > 0 && <Badge kind="accent">{plural(ov.faults, 'fault rule')}</Badge>}
              {ov.lastInvoiceAt && <span className="small faint">last invoice {timeAgo(ov.lastInvoiceAt)}</span>}
            </div>
          </div>
          <Tabs className="einv-tabs" label="E-invoicing" value={tab} onChange={(t) => setParam('tab', t, 'invoices')} items={EINVOICE_TABS.map((t) => ({ id: t.id as Tab, label: t.label }))} />
          {tab === 'invoices' && <InvoicesTab slug={slug} inst={inst} />}
          {tab === 'onboarding' && <OnboardingTab slug={slug} inst={inst} instances={list} />}
          {tab === 'chains' && <ChainsTab slug={slug} inst={inst} />}
          {tab === 'faults' && <EinvoiceFaults slug={slug} inst={inst} instances={list} />}
          {tab === 'checks' && <EinvoiceChecks slug={slug} inst={inst ?? list[0]} />}
          {tab === 'connect' && <EinvoiceConnectTab slug={slug} inst={inst ?? list[0]} />}
        </>
      )}
    </Page>
  );
}

// ---------------- invoices ----------------

const ENDPOINT_LABEL: Record<ZatcaEndpoint, string> = {
  compliance: 'compliance CSID',
  compliance_invoices: 'compliance check',
  csids: 'production CSID',
  csids_renew: 'CSID renewal',
  reporting: 'reporting',
  clearance: 'clearance',
};
const TYPE_CODE_LABEL: Record<string, string> = { '388': 'invoice', '381': 'credit note', '383': 'debit note' };
const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'Any status' },
  { id: 'CLEARED,REPORTED,PASS', label: 'Accepted' },
  { id: 'WARNING', label: 'Accepted with warnings' },
  { id: 'NOT_REPORTED,NOT_CLEARED,ERROR', label: 'Rejected' },
  { id: 'DUPLICATE', label: 'Duplicate' },
  { id: 'FAULT', label: 'Fault' },
];

function InvoicesTab({ slug, inst }: { slug: string; inst: EinvoiceInstance | null }) {
  const toast = useToast();
  const gate = useGate(slug)('walkthroughs.run');
  const [endpoint, setEndpoint] = useState<ZatcaEndpoint | ''>('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useTick(30_000);
  const q = qs({ instance: inst?.slug, endpoint: endpoint || undefined, status: status || undefined, limit: 200 });
  const list = useEinvoiceFetch<Einvoice[]>(slug, `${einvoiceBase(slug)}/invoices${q}`);
  const clear = async () => {
    if (!window.confirm(inst ? `Delete every invoice of ${inst.name}? Chains and CSIDs stay.` : 'Delete every invoice of the project? Chains and CSIDs stay.')) return;
    try {
      const r = await einvoiceApi.clearInvoices(slug, { instance: inst?.slug });
      toast(`${plural(r.deleted, 'invoice')} deleted`);
      void list.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const rows = list.data ?? [];
  return (
    <div className="stack">
      <div className="row einv-filters">
        <select value={endpoint} onChange={(e) => setEndpoint(e.target.value as ZatcaEndpoint | '')} aria-label="Endpoint">
          <option value="">Any endpoint</option>
          {(['reporting', 'clearance', 'compliance_invoices'] as const).map((e) => (
            <option key={e} value={e}>
              {ENDPOINT_LABEL[e]}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button className="btn ghost" onClick={() => void clear()} disabled={!rows.length || !!gate.disabled} title={gate.title}>
          Clear invoices
        </button>
      </div>
      <ErrorBox error={list.error} />
      <div className="card">
        {!list.data ? (
          <p className="card-pad muted">Loading…</p>
        ) : !rows.length ? (
          <Empty title={endpoint || status ? 'No matching invoices' : 'No invoices yet'}>
            <p className="small muted">Invoices appear here when your EGS calls the compliance checks, reporting or clearance of the fake Fatoora. The Checks tab makes a sample invoice to try.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="einv-table einv-invoices">
              <caption className="sr-only">E-invoices, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Type</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Number / ICV</th>
                  <th scope="col">Status</th>
                  <th scope="col">Messages</th>
                  <th scope="col">Run</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <InvoiceRow key={i.id} inv={i} showInstance={!inst} onOpen={() => setOpen(i.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open && <InvoiceDrawer slug={slug} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function InvoiceRow({ inv, showInstance, onOpen }: { inv: Einvoice; showInstance: boolean; onOpen: () => void }) {
  const errors = inv.validation?.errorMessages.length ?? 0;
  const warnings = inv.validation?.warningMessages.length ?? 0;
  return (
    <tr className="clickable" onClick={onOpen}>
      <td className="small nowrap" title={fmtDateTime(inv.createdAt)}>
        {timeAgo(inv.createdAt)}
      </td>
      <td className="small">
        {inv.docType ?? <span className="faint">unknown</span>}
        {inv.typeCode && (
          <div className="faint">
            {inv.typeCode} {TYPE_CODE_LABEL[inv.typeCode] ?? ''}
          </div>
        )}
      </td>
      <td className="small">
        {ENDPOINT_LABEL[inv.endpoint]}
        {showInstance && inv.instance && <div className="faint">{inv.instance}</div>}
      </td>
      <td className="small">
        <button
          className="btn xs ghost einv-open"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          aria-label={`Open invoice ${inv.number ?? inv.id}`}
        >
          {inv.number ?? <span className="faint">no number</span>}
        </button>
        <div className="faint">ICV {inv.icv ?? '–'}</div>
      </td>
      <td>
        <InvoiceStatus status={inv.status} title={`HTTP ${inv.httpStatus}`} />
        {inv.fault && <div className="small faint">fault {inv.fault}</div>}
      </td>
      <td>
        <div className="row einv-chips">
          {errors > 0 && <Badge kind="bad">{plural(errors, 'error')}</Badge>}
          {warnings > 0 && <Badge kind="warn">{plural(warnings, 'warning')}</Badge>}
          {inv.lint.length > 0 && <Badge kind={inv.lintLevel === 'error' ? 'bad' : inv.lintLevel === 'warn' ? 'warn' : ''}>{plural(inv.lint.length, 'check')}</Badge>}
          {!errors && !warnings && !inv.lint.length && <span className="small faint">none</span>}
        </div>
      </td>
      <td>{inv.run ? <RunChip runKey={inv.run} /> : <span className="small faint">none</span>}</td>
    </tr>
  );
}

/** QR payload of the invoice XML (the AdditionalDocumentReference with ID QR), decoded from its TLV. */
const QR_TAGS: Record<number, string> = {
  1: 'Seller name',
  2: 'VAT number',
  3: 'Timestamp',
  4: 'Total with VAT',
  5: 'VAT total',
  6: 'Invoice hash',
  7: 'Signature',
  8: 'Public key',
  9: 'Certificate signature',
};
function decodeQr(xml: string | null): { fields: { tag: number; value: string }[] } | { error: string } | null {
  if (!xml) return null;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return { error: 'The XML could not be parsed' };
  }
  if (doc.getElementsByTagName('parsererror').length) return { error: 'The XML could not be parsed' };
  const refs = Array.from(doc.getElementsByTagNameNS('*', 'AdditionalDocumentReference'));
  const qr = refs.find((r) => Array.from(r.children).some((c) => c.localName === 'ID' && c.textContent?.trim() === 'QR'));
  const b64 = qr ? Array.from(qr.getElementsByTagNameNS('*', 'EmbeddedDocumentBinaryObject'))[0]?.textContent?.trim() : undefined;
  if (!b64) return { error: 'The invoice has no QR code' };
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return { error: 'The QR payload is not base64' };
  }
  const fields: { tag: number; value: string }[] = [];
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < bytes.length; ) {
    if (i + 2 > bytes.length) return { error: `Truncated TLV header at byte ${i}` };
    const tag = bytes[i];
    const len = bytes[i + 1];
    if (i + 2 + len > bytes.length) return { error: `Tag ${tag} length ${len} overflows the payload` };
    const v = bytes.subarray(i + 2, i + 2 + len);
    let value: string;
    try {
      // Tags 8 and 9 are raw bytes: shown as base64.
      value = tag >= 8 ? btoa(String.fromCharCode(...v)) : utf8.decode(v);
    } catch {
      value = btoa(String.fromCharCode(...v));
    }
    fields.push({ tag, value });
    i += 2 + len;
  }
  return { fields };
}

function Mono({ v }: { v: string | number | null | undefined }) {
  return v === null || v === undefined || v === '' ? <span className="faint">none</span> : <code className="einv-cut">{String(v)}</code>;
}

function InvoiceDrawer({ slug, id, onClose }: { slug: string; id: string; onClose: () => void }) {
  const d = useEinvoiceFetch<EinvoiceDetail>(slug, `${einvoiceBase(slug)}/invoices/${encodeURIComponent(id)}`);
  const [log, setLog] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const i = d.data;
  const qr = i ? decodeQr(i.clearedXml ?? i.xml) : null;
  const facts: KV[] = i
    ? [
        { label: 'Type', value: `${i.docType ?? 'unknown'}${i.typeCode ? ` · ${i.typeCode} ${TYPE_CODE_LABEL[i.typeCode] ?? ''}` : ''}${i.typeName ? ` (${i.typeName})` : ''}` },
        { label: 'Endpoint', value: `${ENDPOINT_LABEL[i.endpoint]} · HTTP ${i.httpStatus}` },
        { label: 'Instance', value: i.instance ?? <span className="faint">deleted</span> },
        { label: 'Issued', value: i.issueAt ? fmtDateTime(i.issueAt) : <span className="faint">unknown</span> },
        { label: 'Received', value: fmtDateTime(i.createdAt) },
        { label: 'Seller', value: `${i.sellerName ?? 'unknown'}${i.sellerVat ? ` · VAT ${i.sellerVat}` : ''}` },
        { label: 'Buyer', value: i.buyerName || i.buyerVat ? `${i.buyerName ?? ''}${i.buyerVat ? ` · VAT ${i.buyerVat}` : ''}` : <span className="faint">none</span> },
        { label: 'Totals', value: i.totalIncl ? `${i.totalExcl ?? '?'} + VAT ${i.vatTotal ?? '?'} = ${i.totalIncl} ${i.currency ?? ''}` : <span className="faint">unknown</span> },
        { label: 'UUID', value: <Mono v={i.uuid} /> },
        ...(i.fault ? [{ label: 'Fault', value: <Badge kind="accent">{i.fault}</Badge> }] : []),
        ...(i.duplicateOf ? [{ label: 'Duplicate of', value: <Mono v={i.duplicateOf} /> }] : []),
        ...(i.run ? [{ label: 'Run', value: <RunChip runKey={i.run} /> }] : []),
      ]
    : [];
  const chain: KV[] = i
    ? [
        { label: 'ICV', value: <Mono v={i.icv} /> },
        { label: 'PIH', value: <Mono v={i.pih} /> },
        { label: 'Invoice hash', value: <Mono v={i.invoiceHash} /> },
        {
          label: 'Computed hash',
          value: (
            <>
              <Mono v={i.computedHash} />
              {i.invoiceHash && i.computedHash && i.invoiceHash !== i.computedHash && (
                <>
                  {' '}
                  <Badge kind="bad">does not match the sent hash</Badge>
                </>
              )}
            </>
          ),
        },
        { label: 'Chain', value: i.chain ? `${i.chain.scope} · VAT ${i.chain.vatNumber} · EGS ${i.chain.egsKey}` : <span className="faint">not chained</span> },
        { label: 'CSID', value: <Mono v={i.csidId} /> },
      ]
    : [];
  const xml = cleared ? i?.clearedXml : i?.xml;
  const response = i ? { ...(i.validation ? { validationResults: i.validation } : {}), status: i.status, httpStatus: i.httpStatus } : null;
  return (
    <Drawer
      title={
        <div className="stack einv-drawer-head">
          <strong>{i ? (i.number ?? 'Invoice without a number') : 'Invoice'}</strong>
          {i && (
            <div className="row einv-chips">
              <InvoiceStatus status={i.status as EinvoiceStatus} />
              <span className="small faint">{ENDPOINT_LABEL[i.endpoint]}</span>
            </div>
          )}
        </div>
      }
      onClose={onClose}
    >
      <ErrorBox error={d.error} />
      {!i ? (
        !d.error && <p className="muted">Loading…</p>
      ) : (
        <div className="stack">
          <KeyValue items={facts} wide />
          <section className="stack" aria-labelledby="einv-d-val">
            <h3 id="einv-d-val">Validation results</h3>
            {i.validation ? <ValidationTable results={i.validation} caption="Validation messages of this invoice" /> : <p className="small muted">No validation results (the request did not reach validation).</p>}
          </section>
          <section className="stack" aria-labelledby="einv-d-lint">
            <h3 id="einv-d-lint">Integration checks</h3>
            {i.lint.length ? <LintTable findings={i.lint} caption="Integration check findings of this invoice" /> : <p className="small muted">No integration problems.</p>}
          </section>
          <section className="stack" aria-labelledby="einv-d-chain">
            <h3 id="einv-d-chain">Hash and chain</h3>
            <KeyValue items={chain} wide />
          </section>
          <section className="stack" aria-labelledby="einv-d-qr">
            <h3 id="einv-d-qr">QR code</h3>
            {!qr ? (
              <p className="small muted">No XML stored.</p>
            ) : 'error' in qr ? (
              <p className="small muted">{qr.error}</p>
            ) : (
              <KeyValue items={qr.fields.map((f) => ({ key: String(f.tag), label: `${f.tag} ${QR_TAGS[f.tag] ?? ''}`, value: <code className="einv-cut">{f.value}</code> }))} wide />
            )}
          </section>
          <section className="stack" aria-labelledby="einv-d-xml">
            <div className="row">
              <h3 id="einv-d-xml" className="grow">
                XML
              </h3>
              {i.hasClearedXml && (
                <label className="row nowrap small">
                  <input type="checkbox" checked={cleared} onChange={(e) => setCleared(e.target.checked)} /> Cleared copy
                </label>
              )}
              {(cleared ? i.hasClearedXml : i.hasXml) && (
                <a className="btn sm" href={invoiceXmlUrl(slug, i.id, { cleared, download: true })}>
                  Download XML
                </a>
              )}
            </div>
            {xml ? <CodeBlock title={cleared ? 'Cleared XML (stamped by the fake ZATCA)' : 'Invoice XML as sent'} lang="markup" code={xml} wrap={false} /> : <p className="small muted">No XML stored.</p>}
          </section>
          <section className="stack" aria-labelledby="einv-d-resp">
            <h3 id="einv-d-resp">Response</h3>
            {response && <CodeBlock title="Response (validation part)" lang="json" code={JSON.stringify(response, null, 2)} />}
            {Object.keys(i.headers).length > 0 && <CodeBlock title="Request headers" code={Object.entries(i.headers).map(([k, v]) => `${k}: ${v}`).join('\n')} />}
            {i.logId && (
              <div>
                <button className="btn sm ghost" onClick={() => setLog(i.logId)}>
                  <Icon name="activity" size={13} /> Full request and response in the traffic log
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {log && <LogDrawer id={log} onClose={() => setLog(null)} />}
    </Drawer>
  );
}

// ---------------- onboarding ----------------

const DOC_KINDS: DocKind[] = ['standard:388', 'standard:381', 'standard:383', 'simplified:388', 'simplified:381', 'simplified:383'];
const CSID_KIND: Record<EinvoiceCsid['status'], string> = { active: 'ok', superseded: '', revoked: 'bad', expired: 'warn' };

function OnboardingTab({ slug, inst, instances }: { slug: string; inst: EinvoiceInstance | null; instances: EinvoiceInstance[] }) {
  const toast = useToast();
  const gate = useGate(slug)('project.providers');
  useTick(30_000);
  const list = useEinvoiceFetch<EinvoiceCsid[]>(slug, `${einvoiceBase(slug)}/csids${qs({ instance: inst?.slug })}`);
  const [otp, setOtp] = useState<(EinvoiceOtp & { instance: string }) | null>(null);
  const otpInst = inst ?? instances[0];
  const issue = () =>
    void einvoiceApi
      .issueOtp(slug, otpInst.slug)
      .then((o) => setOtp({ ...o, instance: otpInst.name }))
      .catch((e) => toast(errText(e)));
  const act = async (c: EinvoiceCsid, what: 'revoke' | 'expire') => {
    if (!window.confirm(what === 'revoke' ? `Revoke this ${c.kind} CSID? Calls with it answer 401.` : `Expire this ${c.kind} CSID now?`)) return;
    try {
      await (what === 'revoke' ? einvoiceApi.revokeCsid(slug, c.id) : einvoiceApi.expireCsid(slug, c.id));
      toast(what === 'revoke' ? 'CSID revoked' : 'CSID expired');
      void list.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const rows = (list.data ?? []).filter((c) => c.kind !== 'demo');
  const active = rows.filter((c) => c.status === 'active');
  const compliance = active.find((c) => c.kind === 'compliance');
  const done = [
    !!otp || rows.length > 0,
    rows.length > 0,
    rows.some((c) => c.kind === 'compliance'),
    rows.some((c) => c.kind === 'production') || (!!compliance?.progress && compliance.progress.done >= compliance.progress.needed),
    active.some((c) => c.kind === 'production'),
  ];
  const steps = [
    { title: 'Get an OTP', text: 'Generate one here (valid 1 hour), or use the fixed OTP of the instance.' },
    { title: 'Make a CSR', text: `EC secp256k1 key, the certificate template of the environment${otpInst ? ` (${ZATCA_ENV_LABEL[otpInst.config.env]})` : ''}, VAT number, EGS serial and invoice types.` },
    { title: 'Compliance CSID', text: 'POST /compliance with the OTP header and the CSR: the answer has the binarySecurityToken and secret.' },
    { title: 'Compliance invoices', text: 'POST /compliance/invoices one sample of each kind the CSR declared, with the compliance CSID as Basic auth.' },
    { title: 'Production CSID', text: 'POST /production/csids with the compliance request id: use the new CSID for reporting and clearance.' },
  ];
  const current = done.indexOf(false);
  return (
    <div className="stack">
      <div className="einv-grid">
        <div className="card card-pad stack">
          <h3>Onboarding steps</h3>
          <ol className="einv-steps">
            {steps.map((s, n) => (
              <li key={s.title} className={done[n] ? 'done' : n === current ? 'current' : ''} aria-current={n === current ? 'step' : undefined}>
                <span className="einv-step-mark" aria-hidden>
                  {done[n] ? <Icon name="check" size={12} /> : n + 1}
                </span>
                <span>
                  <strong>{s.title}</strong> <span className="small faint">{done[n] ? '(done)' : n === current ? '(next)' : ''}</span>
                  <div className="small muted">{s.text}</div>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="card card-pad stack">
          <div className="row">
            <h3 className="grow">OTP</h3>
            <button className="btn sm primary" onClick={issue} disabled={!otpInst || !!gate.disabled} title={gate.title}>
              Generate OTP
            </button>
          </div>
          <p className="small muted">
            For {otpInst?.name}: {otpInst?.config.otp ? `the fixed OTP ${otpInst.config.otp} works too.` : 'any 6 digits work too.'}
          </p>
          {otp && (
            <div className="row">
              <code className="einv-otp">{otp.otp}</code>
              <span className="small faint">
                {otp.instance}, expires {timeUntil(otp.expiresAt) || 'now'}
              </span>
            </div>
          )}
        </div>
      </div>
      <ErrorBox error={list.error} />
      <div className="card">
        <div className="card-head">
          <h3>{plural(rows.length, 'CSID')}</h3>
        </div>
        {!list.data ? (
          <p className="card-pad muted">Loading…</p>
        ) : !rows.length ? (
          <Empty title="No CSIDs yet">
            <p className="small muted">A compliance CSID appears when your EGS calls /compliance with an OTP and a CSR.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="einv-table">
              <caption className="sr-only">CSIDs, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">EGS</th>
                  <th scope="col">Compliance checks</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="small">
                      <strong>{c.kind}</strong>
                      <div className="faint">req {c.requestId}</div>
                      {!inst && c.instance && <div className="faint">{c.instance}</div>}
                    </td>
                    <td>
                      <Badge kind={CSID_KIND[c.status]}>{c.status}</Badge>
                      {c.run && (
                        <div>
                          <RunChip runKey={c.run} />
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {c.commonName ?? <span className="faint">no name</span>}
                      <div className="faint">
                        VAT {c.vatNumber ?? '?'} · {c.egsSerial ?? 'no serial'}
                      </div>
                    </td>
                    <td>{c.kind === 'compliance' ? <ComplianceCells c={c} /> : <span className="small faint">not needed</span>}</td>
                    <td className="small nowrap">{c.expiresAt ? <span title={fmtDateTime(c.expiresAt)}>{timeUntil(c.expiresAt) || 'expired'}</span> : <span className="faint">never</span>}</td>
                    <td className="nowrap">
                      {c.status === 'active' && (
                        <div className="row nowrap einv-chips">
                          <button className="btn xs ghost" onClick={() => void act(c, 'expire')} {...gate}>
                            Expire
                          </button>
                          <button className="btn xs ghost" onClick={() => void act(c, 'revoke')} {...gate}>
                            Revoke
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** The 6 compliance-check cells (standard / simplified × invoice, credit and debit note): passed, needed or not declared. */
function ComplianceCells({ c }: { c: EinvoiceCsid }) {
  const needed = new Set(c.progress?.kinds ?? []);
  return (
    <div className="stack einv-cells-wrap">
      <ul className="einv-cells" aria-label="Compliance checks by invoice kind">
        {DOC_KINDS.map((k) => {
          const passed = !!c.checks[k];
          const state = passed ? 'passed' : needed.has(k) ? 'needed' : 'not declared';
          const [type, code] = k.split(':');
          return (
            <li key={k} className={`einv-cell ${passed ? 'ok' : needed.has(k) ? 'todo' : 'off'}`} title={`${type} ${TYPE_CODE_LABEL[code]}: ${state}`}>
              <span aria-hidden>{passed ? '✓' : needed.has(k) ? '○' : '–'}</span>
              <span className="sr-only">
                {type} {TYPE_CODE_LABEL[code]}: {state}
              </span>
              <span className="einv-cell-label" aria-hidden>
                {type === 'standard' ? 'B2B' : 'B2C'} {code}
              </span>
            </li>
          );
        })}
      </ul>
      {c.progress && (
        <span className="small faint">
          {c.progress.done} of {c.progress.needed} passed
        </span>
      )}
    </div>
  );
}

// ---------------- chains ----------------

function ChainsTab({ slug, inst }: { slug: string; inst: EinvoiceInstance | null }) {
  const toast = useToast();
  const gate = useGate(slug)('walkthroughs.run');
  useTick(30_000);
  const list = useEinvoiceFetch<EinvoiceChain[]>(slug, `${einvoiceBase(slug)}/chains${qs({ instance: inst?.slug })}`);
  const reset = async (c: EinvoiceChain) => {
    if (!window.confirm(`Reset the ${c.scope} chain of EGS ${c.egsKey}? The next invoice must start again at ICV 1 with the first PIH.`)) return;
    try {
      await einvoiceApi.resetChain(slug, c.id);
      toast('Chain reset');
      void list.reload();
    } catch (e) {
      toast(errText(e));
    }
  };
  const rows = list.data ?? [];
  return (
    <div className="stack">
      <ErrorBox error={list.error} />
      <div className="card">
        {!list.data ? (
          <p className="card-pad muted">Loading…</p>
        ) : !rows.length ? (
          <Empty title="No chains yet">
            <p className="small muted">Each EGS gets an ICV / PIH chain with its first invoice; compliance and production chains are separate.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="einv-table">
              <caption className="sr-only">ICV and PIH chains by seller and EGS</caption>
              <thead>
                <tr>
                  <th scope="col">EGS</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Invoices</th>
                  <th scope="col">Last ICV / hash</th>
                  <th scope="col">Next expected</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className="small">
                      <strong>{c.egsKey}</strong>
                      <div className="faint">
                        {c.sellerName ?? 'seller'} · VAT {c.vatNumber}
                      </div>
                      {!inst && c.instance && <div className="faint">{c.instance}</div>}
                    </td>
                    <td>
                      <Badge kind={c.scope === 'production' ? 'ok' : ''}>{c.scope}</Badge>
                    </td>
                    <td className="small">{c.count}</td>
                    <td className="small">
                      ICV {c.lastIcv ?? '–'}
                      {c.lastNumber && <span className="faint"> · {c.lastNumber}</span>}
                      <div>
                        <Mono v={c.lastHash} />
                      </div>
                    </td>
                    <td className="small">
                      ICV {c.next.icv}
                      <div>
                        PIH <Mono v={c.next.pih} />
                      </div>
                    </td>
                    <td className="small faint nowrap" title={fmtDateTime(c.updatedAt)}>
                      {timeAgo(c.updatedAt)}
                    </td>
                    <td>
                      <button className="btn xs ghost" onClick={() => void reset(c)} {...gate}>
                        Reset chain
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
