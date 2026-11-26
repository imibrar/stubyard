/** MCP tools for e-invoicing (B6 §4, fake ZATCA Fatoora), spread into TOOLS in http/routes/mcp.ts. All single-call tools. */
import { EINVOICE_FAULTS } from './faults.js';
import { BREAK_NAMES } from './zatca/sample.js';

type Json = Record<string, unknown>;
interface EinvoiceTool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  call: (a: Json) => [string, string, unknown?];
}

const s = (description: string, extra: Json = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const o = (description: string) => ({ type: 'object', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const enc = encodeURIComponent;
const qs = (q: Record<string, unknown>) => {
  const parts = Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${enc(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const PROJECT = s('stubyard project slug, e.g. "hyper"');
const INSTANCE = s('E-invoicing instance slug or id (see list_einvoice_instances)');
const INSTANCE_OPT = s('E-invoicing instance slug or id (default: the project\'s first instance)');
const RUN = s('Test run key or id: only that run\'s data');
const ENDPOINT = s('ZATCA endpoint', { enum: ['compliance', 'compliance_invoices', 'csids', 'csids_renew', 'reporting', 'clearance'] });
const DOC_TYPE = s('standard (B2B, cleared) | simplified (B2C, reported)', { enum: ['standard', 'simplified'] });
const RO = { readOnlyHint: true, openWorldHint: false };
const base = (a: Json) => `/api/projects/${enc(String(a.project))}/einvoice`;
/** Invoice list filters shared by list_einvoices and wait_for_einvoice. */
const INVOICE_FILTERS = {
  instance: INSTANCE,
  run: RUN,
  endpoint: ENDPOINT,
  status: s('ZATCA status, comma separated, e.g. "REPORTED,CLEARED" (also NOT_REPORTED, NOT_CLEARED, PASS, WARNING, ERROR)'),
  doc_type: DOC_TYPE,
  seller: s('Seller VAT number'),
  number: s('Invoice number (cbc:ID)'),
  after: s('Cursor: only invoices after this e-invoice id'),
  since: s('ISO timestamp'),
};
const filters = (a: Json) => ({ run: a.run, instance: a.instance, endpoint: a.endpoint, status: a.status, docType: a.doc_type, seller: a.seller, number: a.number, after: a.after, since: a.since });

export const EINVOICE_MCP_TOOLS: EinvoiceTool[] = [
  {
    name: 'list_einvoice_instances',
    description: 'E-invoicing instances (fake ZATCA Fatoora) of a project: slug, env, config and the URLs your app points at (base URL, compliance, reporting, clearance).',
    inputSchema: obj({ project: PROJECT }, ['project']),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/instances`],
  },
  {
    name: 'create_einvoice_instance',
    description:
      'Create a fake ZATCA Fatoora instance (it gets its own fake CA). config: { env: "developer-portal" | "simulation" | "core", requireComplianceChecks?, checks?, … } (defaults in GET /api/einvoice-reference). The answer has the URLs for your app.',
    inputSchema: obj({ project: PROJECT, slug: s('Instance slug (default "zatca", then "zatca-2", …)'), name: s('Display name'), config: o('Instance config, e.g. { "env": "simulation" }') }, ['project']),
    call: (a) => ['POST', `${base(a)}/instances`, { slug: a.slug, name: a.name, config: a.config }],
  },
  {
    name: 'issue_einvoice_otp',
    description: 'Issue a one-time OTP for onboarding (the otp header of POST /compliance), valid for one hour. The instance\'s fixed OTP (config.otp) also works.',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, run: RUN }, ['project', 'instance']),
    call: (a) => ['POST', `${base(a)}/instances/${enc(String(a.instance))}/otp${qs({ run: a.run })}`],
  },
  {
    name: 'list_einvoice_csids',
    description: 'CSIDs issued by the fake ZATCA (compliance, production, demo): status, expiry, VAT number, EGS serial and, for compliance CSIDs, the compliance-check progress (done / needed).',
    inputSchema: obj(
      {
        project: PROJECT,
        instance: INSTANCE,
        run: RUN,
        kind: s('compliance | production | demo', { enum: ['compliance', 'production', 'demo'] }),
        status: s('active | revoked | expired | superseded'),
      },
      ['project'],
    ),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/csids${qs({ instance: a.instance, run: a.run, kind: a.kind, status: a.status })}`],
  },
  {
    name: 'list_einvoices',
    description: 'E-invoices your app sent to the fake ZATCA (newest first): number, uuid, type, endpoint, ZATCA status, warnings/errors and lint. Filter by instance, run, endpoint, status, doc_type, seller, number or a cursor.',
    inputSchema: obj({ project: PROJECT, ...INVOICE_FILTERS, limit: n('Max invoices (default 100, max 1000)') }, ['project']),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/invoices${qs({ ...filters(a), limit: a.limit })}`],
  },
  {
    name: 'get_einvoice',
    description: 'One e-invoice with its XML (and cleared XML for standard invoices), the validation results and the chain it belongs to.',
    inputSchema: obj({ project: PROJECT, id: s('E-invoice id (see list_einvoices)') }, ['project', 'id']),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/invoices/${enc(String(a.id))}`],
  },
  {
    name: 'wait_for_einvoice',
    description:
      'Wait until your app has sent matching e-invoices (reporting / clearance / compliance checks). Without a cursor, invoices of the last lookback seconds count (default 10; inside a run, since its start). ' +
      'count: at least that many; exactly: that many and no more after settle seconds. Answers { timedOut, invoices, cursor }; pass cursor as after to wait for the next one.',
    inputSchema: obj(
      {
        project: PROJECT,
        ...INVOICE_FILTERS,
        lookback: n('Seconds back to look when there is no cursor (default 10)'),
        count: n('Wait for at least this many (default 1)'),
        exactly: n('Wait for exactly this many (fails when more arrive)'),
        timeout: n('Seconds to wait (default 30, max 120)'),
        settle: n('With exactly: seconds to make sure no more arrive (default 2)'),
      },
      ['project'],
    ),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/invoices/wait${qs({ ...filters(a), lookback: a.lookback, count: a.count, exactly: a.exactly, timeout: a.timeout, settle: a.settle })}`],
  },
  {
    name: 'einvoice_lint',
    description: 'Lint of the e-invoices and CSIDs your app sent (things ZATCA accepts today but that point to bugs): level, counts by severity and check, and the findings with their invoice or CSID.',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/lint${qs({ run: a.run })}`],
  },
  {
    name: 'validate_einvoice',
    description:
      'Validate an invoice XML with the same checks as the fake ZATCA, without sending or storing anything (no chain check). Answers status (PASS / WARNING / ERROR), validationResults as ZATCA would send them, findings, lint and the parsed fields.',
    inputSchema: obj(
      {
        project: PROJECT,
        xml: s('Invoice XML text or base64'),
        invoice_hash: s('The invoiceHash your app would send (checked against the XML)'),
        uuid: s('The uuid your app would send'),
        endpoint: ENDPOINT,
        instance: INSTANCE_OPT,
      },
      ['project', 'xml'],
    ),
    annotations: RO,
    call: (a) => ['POST', `${base(a)}/validate`, { xml: a.xml, invoiceHash: a.invoice_hash, uuid: a.uuid, endpoint: a.endpoint, instance: a.instance }],
  },
  {
    name: 'einvoice_sample',
    description:
      `A signed sample invoice from the instance's demo EGS (with QR), ready to send: { xml, invoice (base64), invoiceHash, uuid, endpoint, auth (a demo CSID accepted by reporting and clearance) }. break: deliberate mistakes (${BREAK_NAMES.join(', ')}); expect lists the codes they cause.`,
    inputSchema: obj(
      {
        project: PROJECT,
        instance: INSTANCE_OPT,
        type: DOC_TYPE,
        kind: s('388 invoice (default) | 381 credit note | 383 debit note', { enum: ['388', '381', '383'] }),
        break: { type: 'array', description: 'Deliberate mistakes', items: { type: 'string', enum: [...BREAK_NAMES] } },
        icv: n('Invoice counter value (default 1)'),
        pih: s('Previous invoice hash (default: the first-invoice PIH)'),
        number: s('Invoice number (default SME00001 for icv 1)'),
        lang: s('Seller name language (default ar)', { enum: ['ar', 'en'] }),
      },
      ['project'],
    ),
    call: (a) => ['POST', `${base(a)}/sample`, { instance: a.instance, type: a.type, kind: a.kind, break: a.break, icv: a.icv, pih: a.pih, number: a.number, lang: a.lang }],
  },
  {
    name: 'set_einvoice_fault',
    description:
      `Make the fake ZATCA fail on purpose. fault: ${EINVOICE_FAULTS.join(' | ')} (some take ":<arg>", e.g. "reject:BR-KSA-37", "slow:3000"; see GET /api/einvoice-reference). ` +
      'Match by endpoint, doc_type, number, seller or csid; times: only the next N requests (default every request). Inside a run (run) it is cleared with the run. Clear with clear_einvoice_faults.',
    inputSchema: obj(
      {
        project: PROJECT,
        fault: s('Fault, e.g. "reject", "warning:BR-KSA-08", "unauthorized", "server_error"'),
        instance: INSTANCE,
        run: s('Active test run key or id: the fault only applies to that run'),
        endpoint: ENDPOINT,
        doc_type: DOC_TYPE,
        number: s('Invoice number'),
        seller: s('Seller VAT number'),
        csid: s('CSID id'),
        times: n('Only the next N matching requests'),
      },
      ['project', 'fault'],
    ),
    call: (a) => ['POST', `${base(a)}/faults`, { fault: a.fault, instance: a.instance, run: a.run, endpoint: a.endpoint, docType: a.doc_type, number: a.number, seller: a.seller, csid: a.csid, times: a.times }],
  },
  {
    name: 'clear_einvoice_faults',
    description: 'Remove the e-invoicing faults set with set_einvoice_fault: those of a run (run), else the project-wide ones.',
    inputSchema: obj({ project: PROJECT, run: RUN }, ['project']),
    annotations: { destructiveHint: true },
    call: (a) => ['DELETE', `${base(a)}/faults${qs({ run: a.run })}`],
  },
  {
    name: 'list_einvoice_chains',
    description: 'Invoice chains (one per seller VAT number and EGS unit): last ICV, last hash and the next expected ICV and PIH.',
    inputSchema: obj({ project: PROJECT, instance: INSTANCE, scope: s('compliance | production', { enum: ['compliance', 'production'] }) }, ['project']),
    annotations: RO,
    call: (a) => ['GET', `${base(a)}/chains${qs({ instance: a.instance, scope: a.scope })}`],
  },
  {
    name: 'reset_einvoice_chain',
    description: 'Reset an invoice chain: the next invoice starts again at ICV 1 with the first-invoice PIH.',
    inputSchema: obj({ project: PROJECT, chain: s('Chain id (see list_einvoice_chains or get_einvoice)') }, ['project', 'chain']),
    annotations: { destructiveHint: true },
    call: (a) => ['POST', `${base(a)}/chains/${enc(String(a.chain))}/reset`],
  },
  {
    name: 'reset_einvoices',
    description: 'Delete the stored e-invoices: those of a run (run) or an instance, else every e-invoice of the project. CSIDs, chains and faults stay.',
    inputSchema: obj({ project: PROJECT, run: RUN, instance: INSTANCE }, ['project']),
    annotations: { destructiveHint: true },
    call: (a) => ['DELETE', `${base(a)}/invoices${qs({ run: a.run, instance: a.instance })}`],
  },
];
