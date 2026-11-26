import type { Document, Element } from '@xmldom/xmldom';
import { finding, lintFromRule, type EinvoiceLintFinding } from '../lint.js';
import type { Csid, DocType, ZatcaConfig } from '../types.js';
import { tryParse } from './dec.js';
import { hashVariants, invoiceHash } from './hash.js';
import type { ZatcaEndpoint } from './responses.js';
import { ruleFinding, type RuleFinding } from './rules/catalog.js';
import { chainChecks, chainRules, firstPihLint, isRetryOfHead } from './rules/chain.js';
import { cryptoChecks, cryptoRules } from './rules/crypto.js';
import { ksaRules } from './rules/ksa.js';
import { structureRules } from './rules/structure.js';
import { vatRules } from './rules/vat.js';
import { NS, XmlParseError, attr, children, descendants, find, parseXml, text } from './xml.js';

/**
 * The invoice validator: decode → parse → extract → checks → {findings (validationResults), lint}.
 *
 * Phase 1 ('basic'): base64 / UTF-8 decoding, XML parsing (XSD_ZATCA_INVALID), the body uuid against the XML
 * (invalid-uuid), the body invoiceHash against stubyard's hash (invalid-invoice-hash, plus einv.hash-variant naming the
 * wrong method that matches), the first-PIH variant and the ICV / PIH chain of the EGS unit.
 *
 * Phase 2 ('full'): the rule modules in PHASE2 (structure, ksa, vat, crypto, chain) run after the basic checks. Each
 * one is a RuleModule: it gets the parsed context and returns ZATCA findings; every finding also becomes lint. The
 * crypto module runs once through cryptoChecks, whose `einv.*` lint (signature input, accepted variants) is kept.
 * The module findings are deduplicated (dedupeFindings): several modules check the same presence and decimals rules.
 */

/** The fields stubyard stores for an invoice (null when absent or the XML did not parse). */
export interface ExtractedInvoice {
  docType: DocType | null;
  typeCode: string | null;
  /** KSA-2 (InvoiceTypeCode @name, e.g. 0200000). */
  typeName: string | null;
  number: string | null;
  uuid: string | null;
  icv: number | null;
  /** The ICV text as sent (BR-KSA-33 needs digits only; icv is null when it isn't a number). */
  icvText: string | null;
  pih: string | null;
  /** The QR payload (base64 TLV) of AdditionalDocumentReference[ID=QR]. */
  qr: string | null;
  issueDate: string | null;
  issueTime: string | null;
  /** IssueDate + 'T' + IssueTime. */
  issueAt: string | null;
  sellerVat: string | null;
  sellerName: string | null;
  buyerVat: string | null;
  buyerName: string | null;
  currency: string | null;
  /** Decimal strings as written in the XML. */
  totals: { excl: string | null; vat: string | null; incl: string | null };
  /** stubyard's invoice hash (hash.ts), null when it could not be computed. */
  computedHash: string | null;
}

/** The chain state of the EGS unit before this invoice (null: no chain context, e.g. a dry run without an EGS). */
export interface ChainState {
  lastIcv: number | null;
  lastHash: string | null;
  /** Invoice number of the chain head, for the messages. */
  lastNumber?: string | null;
}

export interface ValidateInput {
  /** The invoice: base64 of the XML (as in the API body) or the XML text. */
  xml: string;
  /** The body invoiceHash (undefined: not checked, as in a dry run without one). */
  invoiceHash?: string | null;
  /** The body uuid (undefined: not checked). */
  uuid?: string | null;
  endpoint?: ZatcaEndpoint | null;
  /** The CSID of the request (phase 2: certificate checks). */
  csid?: Csid | null;
  config: Pick<ZatcaConfig, 'checks' | 'chainCheck'> & Partial<ZatcaConfig>;
  chain?: ChainState | null;
  /** The einvoice clock (ms) for date rules such as BR-KSA-04 (undefined: the wall clock). */
  nowMs?: number;
}

export interface ValidateResult {
  /** ZATCA findings (validationResults). */
  findings: RuleFinding[];
  /** Every finding as lint, plus the stubyard-only `einv.*` findings. */
  lint: EinvoiceLintFinding[];
  extracted: ExtractedInvoice;
  /** The decoded XML text (null when it could not be decoded). */
  xmlText: string | null;
  /** The XML parsed (the extracted fields are meaningful). */
  parsed: boolean;
  /** Same hash and ICV as the chain head: a resend of the head (no chain findings, the chain doesn't advance). */
  retryOfHead: boolean;
}

/** What a rule module sees. */
export interface RuleContext {
  doc: Document;
  root: Element;
  xml: string;
  extracted: ExtractedInvoice;
  input: ValidateInput;
}

/** A phase 2 rule module: findings for one invoice (never throws for bad input; it reports it). */
export type RuleModule = (ctx: RuleContext) => RuleFinding[];

/**
 * Phase 2 modules in order (structure, ksa, vat, crypto, chain), run when config.checks is 'full'. cryptoRules is run
 * as cryptoChecks (once), to keep its lint as well.
 */
export const PHASE2: RuleModule[] = [structureRules, ksaRules, vatRules, cryptoRules, chainRules];

export { CHAIN_ERROR_CODE, chainFindings } from './rules/chain.js';

const EMPTY: ExtractedInvoice = {
  docType: null, typeCode: null, typeName: null, number: null, uuid: null, icv: null, icvText: null, pih: null, qr: null,
  issueDate: null, issueTime: null, issueAt: null, sellerVat: null, sellerName: null, buyerVat: null, buyerName: null,
  currency: null, totals: { excl: null, vat: null, incl: null }, computedHash: null,
};

const B64_RE = /^[A-Za-z0-9+/\r\n]+={0,2}\s*$/;

/** The XML text of an invoice sent as base64 (or as text). Throws a message for XSD_ZATCA_INVALID. */
export function decodeInvoice(input: string): string {
  const s = String(input ?? '').trim();
  if (!s) throw new XmlParseError('the invoice is empty');
  let bytes: Buffer;
  if (s.startsWith('<') || s.startsWith('﻿<')) bytes = Buffer.from(s, 'utf8');
  else {
    if (!B64_RE.test(s)) throw new XmlParseError('the invoice is not base64');
    bytes = Buffer.from(s, 'base64');
  }
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new XmlParseError('the invoice is not UTF-8');
  }
  return xml.replace(/^﻿/, '');
}

const trimmed = (v: string | null): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** AdditionalDocumentReference with cbc:ID = id. */
function docRef(root: Element, id: string): Element | null {
  return children(root, 'cac:AdditionalDocumentReference').find((r) => text(r, 'cbc:ID')?.trim() === id) ?? null;
}

const amount = (v: string | null): string | null => {
  const t = trimmed(v);
  return t && tryParse(t).ok ? t : null;
};

/** The stored fields of a parsed invoice. */
export function extractFields(doc: Document, xml: string): ExtractedInvoice {
  const root = doc.documentElement!;
  const typeEl = find(root, 'cbc:InvoiceTypeCode');
  const typeName = typeEl ? trimmed(attr(typeEl, 'name')) : null;
  const icvRef = docRef(root, 'ICV');
  const icvText = icvRef ? trimmed(text(icvRef, 'cbc:UUID')) : null;
  const pihRef = docRef(root, 'PIH');
  const qrRef = docRef(root, 'QR');
  const party = (side: 'cac:AccountingSupplierParty' | 'cac:AccountingCustomerParty') => ({
    vat: trimmed(text(root, `${side}/cac:Party/cac:PartyTaxScheme/cbc:CompanyID`)),
    name: trimmed(text(root, `${side}/cac:Party/cac:PartyLegalEntity/cbc:RegistrationName`)),
  });
  const seller = party('cac:AccountingSupplierParty');
  const buyer = party('cac:AccountingCustomerParty');
  const issueDate = trimmed(text(root, 'cbc:IssueDate'));
  const issueTime = trimmed(text(root, 'cbc:IssueTime'));
  let computedHash: string | null = null;
  try {
    computedHash = invoiceHash(xml);
  } catch {
    computedHash = null;
  }
  return {
    docType: typeName?.startsWith('01') ? 'standard' : typeName?.startsWith('02') ? 'simplified' : null,
    typeCode: typeEl ? trimmed(typeEl.textContent) : null,
    typeName,
    number: trimmed(text(root, 'cbc:ID')),
    uuid: trimmed(text(root, 'cbc:UUID')),
    icv: icvText && /^\d+$/.test(icvText) ? Number(icvText) : null,
    icvText,
    pih: pihRef ? trimmed(text(pihRef, 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject')) : null,
    qr: qrRef ? trimmed(text(qrRef, 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject')) : null,
    issueDate,
    issueTime,
    issueAt: issueDate ? (issueTime ? `${issueDate}T${issueTime}` : issueDate) : null,
    sellerVat: seller.vat,
    sellerName: seller.name,
    buyerVat: buyer.vat,
    buyerName: buyer.name,
    currency: trimmed(text(root, 'cbc:DocumentCurrencyCode')),
    totals: {
      excl: amount(text(root, 'cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount')),
      vat: amount(text(root, 'cac:TaxTotal/cbc:TaxAmount')),
      incl: amount(text(root, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount')),
    },
    computedHash,
  };
}

export type ParsedInvoice = { ok: true; xml: string; doc: Document; extracted: ExtractedInvoice } | { ok: false; xml: string | null; error: string };

/** Decode, parse and extract (no checks): the service uses it to match fault rules before validating. */
export function parseInvoice(input: string): ParsedInvoice {
  let xml: string | null = null;
  try {
    xml = decodeInvoice(input);
    const doc = parseXml(xml);
    const root = doc.documentElement!;
    if (root.localName !== 'Invoice' || root.namespaceURI !== NS.inv) {
      return { ok: false, xml, error: `the root element is ${root.nodeName} (expected Invoice in the namespace ${NS.inv})` };
    }
    return { ok: true, xml, doc, extracted: extractFields(doc, xml) };
  } catch (e) {
    return { ok: false, xml, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Validates one invoice ('basic' checks, then the PHASE2 modules when config.checks is 'full'). */
export function validateInvoice(input: ValidateInput): ValidateResult {
  const findings: RuleFinding[] = [];
  const einv: EinvoiceLintFinding[] = [];
  const p = parseInvoice(input.xml);
  const done = (extracted: ExtractedInvoice, parsed: boolean, retryOfHead: boolean): ValidateResult => ({
    findings,
    lint: [...findings.map(lintFromRule), ...einv],
    extracted,
    xmlText: p.xml,
    parsed,
    retryOfHead,
  });
  if (!p.ok) {
    findings.push(ruleFinding('XSD_ZATCA_INVALID', `The invoice could not be read: ${p.error}`));
    return done(EMPTY, false, false);
  }
  const x = p.extracted;

  if (input.uuid !== undefined && (input.uuid ?? '') !== (x.uuid ?? '')) {
    findings.push(ruleFinding('invalid-uuid', `The uuid in the request body (${input.uuid || 'none'}) does not match the UUID of the XML invoice (${x.uuid ?? 'none'}).`, 'cbc:UUID'));
  }

  if (input.invoiceHash !== undefined && input.invoiceHash !== x.computedHash) {
    findings.push(ruleFinding('invalid-invoice-hash'));
    if (input.invoiceHash) {
      let variant: string | undefined;
      try {
        variant = hashVariants(p.xml).find((v) => v.hash === input.invoiceHash)?.variant;
      } catch {
        variant = undefined;
      }
      if (variant) einv.push(finding('einv.hash-variant', `The invoiceHash matches the hash computed the "${variant}" way, not ZATCA's: ${HASH_VARIANT_HELP[variant] ?? variant}`));
    }
  }

  einv.push(...firstPihLint(x));

  if (input.endpoint === 'reporting' && x.docType === 'standard') {
    einv.push(finding('einv.wrong-endpoint', `Invoice ${x.number ?? '(no number)'} is a standard (B2B) invoice: send it to clearance (invoices/clearance/single), not reporting`));
    findings.push(ruleFinding('BR-KSA-06', 'A standard invoice (KSA-2 name 01…) cannot be reported; it must be cleared.', 'cbc:InvoiceTypeCode/@name'));
  } else if (input.endpoint === 'clearance' && x.docType === 'simplified') {
    einv.push(finding('einv.wrong-endpoint', `Invoice ${x.number ?? '(no number)'} is a simplified (B2C) invoice: send it to reporting (invoices/reporting/single), not clearance`));
    findings.push(ruleFinding('BR-KSA-06', 'A simplified invoice (KSA-2 name 02…) cannot be cleared; it must be reported.', 'cbc:InvoiceTypeCode/@name'));
  }

  const retryOfHead = isRetryOfHead(x, input.chain ?? null);
  const chain = chainChecks(x, input);
  einv.push(...chain.lint);
  findings.push(...chain.findings);

  if (input.config.checks === 'full') {
    const ctx: RuleContext = { doc: p.doc, root: p.doc.documentElement!, xml: p.xml, extracted: x, input };
    const perModule = PHASE2.map((mod) => {
      if (mod !== cryptoRules) return mod(ctx);
      const crypto = cryptoChecks(ctx);
      einv.push(...crypto.lint);
      return crypto.findings;
    });
    findings.push(...dedupeFindings(perModule));
  }

  return done(x, true, retryOfHead);
}

/** A path compared without `[1]` steps (structure writes cac:InvoiceLine for a single line, ksa cac:InvoiceLine[1]). */
const normPath = (path: string | undefined): string => (path ?? '').replace(/\[1\]/g, '');

const isUnder = (path: string, ancestor: string): boolean => path.startsWith(`${ancestor}/`);

/**
 * The findings of the phase 2 modules (in PHASE2 order) without the facts reported twice:
 * - the same code and path (`[1]` steps ignored) as an earlier finding: the first one is kept;
 * - a pathless finding whose code an earlier finding already has;
 * - the same code as a finding of an earlier module whose path is an ancestor (structure reports a missing buyer at
 *   cac:AccountingCustomerParty, ksa the missing name below it).
 */
export function dedupeFindings(perModule: RuleFinding[][]): RuleFinding[] {
  const out: RuleFinding[] = [];
  const keys = new Set<string>();
  const earlier: { code: string; path: string }[] = [];
  for (const list of perModule) {
    const mine: { code: string; path: string }[] = [];
    for (const f of list) {
      const path = normPath(f.path);
      const key = `${f.code}|${path}`;
      if (keys.has(key)) continue;
      if (!path && out.some((o) => o.code === f.code)) continue;
      if (path && earlier.some((e) => e.code === f.code && e.path && isUnder(path, e.path))) continue;
      keys.add(key);
      mine.push({ code: f.code, path });
      out.push(f);
    }
    earlier.push(...mine);
  }
  return out;
}

const HASH_VARIANT_HELP: Record<string, string> = {
  minified: 'the XML was minified (whitespace between elements removed) before hashing; hash the document as sent',
  'qr-kept': 'the QR AdditionalDocumentReference was kept; remove it before canonicalizing',
  'no-transforms': 'UBLExtensions, cac:Signature and the QR were not removed before canonicalizing',
  'exclusive-c14n': 'exclusive C14N was used; ZATCA uses inclusive C14N 1.1',
  'hex-digest': 'the hex text of the digest was base64-encoded; the invoice hash is base64 of the raw SHA-256 bytes',
};

/** Every descendant QR reference (for the stamp): re-exported for the service. */
export const qrRefs = (doc: Document): Element[] =>
  descendants(doc, 'cac:AdditionalDocumentReference').filter((r) => text(r, 'cbc:ID')?.trim() === 'QR');
