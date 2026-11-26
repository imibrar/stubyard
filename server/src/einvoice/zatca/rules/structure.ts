import type { Element } from '@xmldom/xmldom';
import type { RuleContext, RuleModule } from '../validate.js';
import { NS, children, find, isElement } from '../xml.js';
import { ruleFinding, type RuleFinding } from './catalog.js';

/**
 * Phase 2, structure group: the shape of the invoice before any value is judged.
 *
 * - XSD_ZATCA_INVALID: unknown or wrongly namespaced root children, root children out of UBL order, a UBL element that
 *   must occur once but occurs twice, a UBL-mandatory element with no catalog code of its own (PayableAmount, a TaxTotal
 *   without TaxAmount, a missing currencyID).
 * - A mandatory element that has its own catalog code is reported with that code (BR-02 ID, BR-03 IssueDate, BR-04 type
 *   code, BR-05 currency, BR-06/08/09 seller, BR-10 / BR-KSA-42 buyer of a standard invoice, BR-13/14/15 totals, BR-16
 *   and BR-21/22/24/25/CO-04 lines, BR-CO-18 VAT breakdown, BR-KSA-34/61/27 ICV / PIH / QR, BR-53 tax currency total).
 * - Header formats: BR-KSA-25 (ProfileID, missing UUID), BR-KSA-03 (UUID characters), BR-KSA-F-01 (date), BR-KSA-70
 *   (time), BR-KSA-05 (type code value), BR-KSA-06 (type code @name NNPNESB), BR-KSA-68 (TaxCurrencyCode missing).
 *
 * Values and arithmetic belong to the ksa and vat modules; this one only looks at presence, cardinality and format.
 */

const PREFIX_BY_NS = new Map<string, string>([
  [NS.cbc, 'cbc'],
  [NS.cac, 'cac'],
  [NS.ext, 'ext'],
]);

/** UBL 2.1 Invoice children in schema order (prefixed names). */
const UBL_ORDER = [
  'ext:UBLExtensions', 'cbc:UBLVersionID', 'cbc:CustomizationID', 'cbc:ProfileID', 'cbc:ProfileExecutionID', 'cbc:ID',
  'cbc:CopyIndicator', 'cbc:UUID', 'cbc:IssueDate', 'cbc:IssueTime', 'cbc:DueDate', 'cbc:InvoiceTypeCode', 'cbc:Note',
  'cbc:TaxPointDate', 'cbc:DocumentCurrencyCode', 'cbc:TaxCurrencyCode', 'cbc:PricingCurrencyCode',
  'cbc:PaymentCurrencyCode', 'cbc:PaymentAlternativeCurrencyCode', 'cbc:AccountingCostCode', 'cbc:AccountingCost',
  'cbc:LineCountNumeric', 'cbc:BuyerReference', 'cac:InvoicePeriod', 'cac:OrderReference', 'cac:BillingReference',
  'cac:DespatchDocumentReference', 'cac:ReceiptDocumentReference', 'cac:StatementDocumentReference',
  'cac:OriginatorDocumentReference', 'cac:ContractDocumentReference', 'cac:AdditionalDocumentReference',
  'cac:ProjectReference', 'cac:Signature', 'cac:AccountingSupplierParty', 'cac:AccountingCustomerParty', 'cac:PayeeParty',
  'cac:BuyerCustomerParty', 'cac:SellerSupplierParty', 'cac:TaxRepresentativeParty', 'cac:Delivery',
  'cac:DeliveryTerms', 'cac:PaymentMeans', 'cac:PaymentTerms', 'cac:PrepaidPayment', 'cac:AllowanceCharge',
  'cac:TaxExchangeRate', 'cac:PricingExchangeRate', 'cac:PaymentExchangeRate', 'cac:PaymentAlternativeExchangeRate',
  'cac:TaxTotal', 'cac:WithholdingTaxTotal', 'cac:LegalMonetaryTotal', 'cac:InvoiceLine',
];
const ORDER_INDEX = new Map(UBL_ORDER.map((n, i) => [n, i]));

/** UBL Invoice children that may repeat; every other child may occur at most once. */
const REPEATABLE = new Set([
  'cbc:Note', 'cac:BillingReference', 'cac:DespatchDocumentReference', 'cac:ReceiptDocumentReference',
  'cac:StatementDocumentReference', 'cac:OriginatorDocumentReference', 'cac:ContractDocumentReference',
  'cac:AdditionalDocumentReference', 'cac:ProjectReference', 'cac:Signature', 'cac:Delivery', 'cac:PaymentMeans',
  'cac:PaymentTerms', 'cac:PrepaidPayment', 'cac:AllowanceCharge', 'cac:TaxTotal', 'cac:WithholdingTaxTotal',
  'cac:InvoiceLine',
]);
const SINGLE = UBL_ORDER.filter((n) => !REPEATABLE.has(n));

const INVOICE_TYPE_CODES = new Set(['388', '381', '383', '386']);
const TYPE_NAME_RE = /^0[12][01]{5}$/;
const UUID_RE = /^[A-Za-z0-9-]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(Z)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const prefixed = (e: Element): string | null => {
  const p = e.namespaceURI ? PREFIX_BY_NS.get(e.namespaceURI) : undefined;
  return p ? `${p}:${e.localName}` : null;
};

const clean = (e: Element | null): string => (e?.textContent ?? '').trim();

/** The path of an element relative to the Invoice root, `[n]` added where the name repeats (cac:InvoiceLine[2]/cbc:ID). */
function pathOf(e: Element, root: Element): string {
  const steps: string[] = [];
  for (let cur: Element | null = e; cur && cur !== root; cur = isElement(cur.parentNode) ? cur.parentNode : null) {
    const name = prefixed(cur) ?? cur.nodeName;
    const parent = cur.parentNode;
    let step = name;
    if (isElement(parent)) {
      const same = children(parent).filter((c) => c.namespaceURI === cur!.namespaceURI && c.localName === cur!.localName);
      if (same.length > 1) step += `[${same.indexOf(cur) + 1}]`;
    }
    steps.unshift(step);
  }
  return steps.join('/');
}

const join = (parentPath: string, name: string): string => (parentPath ? `${parentPath}/${name}` : name);

class Check {
  readonly out: RuleFinding[] = [];

  constructor(readonly root: Element) {}

  add(code: string, message: string, path: string): void {
    this.out.push(ruleFinding(code, message, path));
  }

  /**
   * The only `name` child of `parent`; `name` must occur once. A second occurrence is reported as XSD_ZATCA_INVALID (or
   * `dupCode`); `missing` gets the code (or null: the caller reports a missing element itself).
   */
  one(parent: Element, name: string, opts: { missing?: string | null; dupCode?: string; what?: string } = {}): Element | null {
    const parentPath = parent === this.root ? '' : pathOf(parent, this.root);
    const found = children(parent, name);
    const what = opts.what ?? name;
    if (found.length === 0) {
      if (opts.missing) this.add(opts.missing, `${what} is missing.`, join(parentPath, name));
      return null;
    }
    for (const extra of found.slice(1)) this.add(opts.dupCode ?? 'XSD_ZATCA_INVALID', `${what} occurs ${found.length} times; it must occur once.`, pathOf(extra, this.root));
    return found[0];
  }

  /** `one()` for a text element: an empty value counts as missing. Returns the trimmed text, or null when missing. */
  text(parent: Element, name: string, opts: { missing: string | null; dupCode?: string; what?: string } = { missing: null }): { el: Element; value: string } | null {
    const e = this.one(parent, name, { ...opts, missing: null });
    const parentPath = parent === this.root ? '' : pathOf(parent, this.root);
    const what = opts.what ?? name;
    if (!e) {
      if (opts.missing) this.add(opts.missing, `${what} is missing.`, join(parentPath, name));
      return null;
    }
    const value = clean(e);
    if (!value) {
      if (opts.missing) this.add(opts.missing, `${what} is empty.`, pathOf(e, this.root));
      return null;
    }
    return { el: e, value };
  }

  /** An amount element needs a currencyID attribute (UBL: required). */
  currency(amount: Element | null): void {
    if (amount && !amount.getAttribute('currencyID')?.trim()) {
      this.add('XSD_ZATCA_INVALID', `${amount.localName} has no currencyID attribute.`, `${pathOf(amount, this.root)}/@currencyID`);
    }
  }
}

function rootChildren(c: Check, root: Element): void {
  let high = -1;
  let highName = '';
  for (const e of children(root)) {
    const name = prefixed(e);
    const path = pathOf(e, root);
    const idx = name ? ORDER_INDEX.get(name) : undefined;
    if (idx === undefined) {
      if (!name && e.namespaceURI) {
        c.add('XSD_ZATCA_INVALID', `Unexpected element ${e.nodeName} in the namespace ${e.namespaceURI}: the Invoice children belong to the UBL cbc, cac or ext namespaces.`, path);
      } else if (!name) {
        c.add('XSD_ZATCA_INVALID', `Unexpected element ${e.nodeName} without a namespace: the Invoice children belong to the UBL cbc, cac or ext namespaces.`, path);
      } else {
        c.add('XSD_ZATCA_INVALID', `Element ${name} is not allowed as a child of Invoice.`, path);
      }
      continue;
    }
    if (idx < high) c.add('XSD_ZATCA_INVALID', `Element ${name} is out of order: UBL requires it before ${highName}.`, path);
    else {
      high = idx;
      highName = name!;
    }
  }
  for (const name of SINGLE) {
    const found = children(root, name);
    for (const extra of found.slice(1)) c.add('XSD_ZATCA_INVALID', `${name} occurs ${found.length} times; it must occur once.`, pathOf(extra, root));
  }
}

function header(c: Check, root: Element): void {
  const profile = c.text(root, 'cbc:ProfileID', { missing: 'BR-KSA-25', what: 'ProfileID (BR-KSA-01)' });
  if (profile && profile.value !== 'reporting:1.0') c.add('BR-KSA-25', `ProfileID must be reporting:1.0, got ${profile.value}.`, pathOf(profile.el, root));

  c.text(root, 'cbc:ID', { missing: 'BR-02', what: 'The invoice number (cbc:ID)' });

  const uuid = c.text(root, 'cbc:UUID', { missing: 'BR-KSA-25', what: 'The invoice UUID (cbc:UUID)' });
  if (uuid && !UUID_RE.test(uuid.value)) c.add('BR-KSA-03', `The UUID ${uuid.value} contains characters other than letters, digits and dashes.`, pathOf(uuid.el, root));

  const date = c.text(root, 'cbc:IssueDate', { missing: 'BR-03', what: 'The issue date (cbc:IssueDate)' });
  if (date) {
    const m = DATE_RE.exec(date.value);
    const ok = m && (() => {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
    })();
    if (!ok) c.add('BR-KSA-F-01', `The issue date ${date.value} is not a date in the format YYYY-MM-DD.`, pathOf(date.el, root));
  }

  const time = c.text(root, 'cbc:IssueTime', { missing: 'BR-KSA-70', what: 'The issue time (cbc:IssueTime)' });
  if (time && !TIME_RE.test(time.value)) c.add('BR-KSA-70', `The issue time ${time.value} is not hh:mm:ss or hh:mm:ssZ.`, pathOf(time.el, root));

  const type = c.one(root, 'cbc:InvoiceTypeCode', { missing: 'BR-04', what: 'The invoice type code (cbc:InvoiceTypeCode)' });
  if (type) {
    const code = clean(type);
    if (!code) c.add('BR-04', 'The invoice type code is empty.', pathOf(type, root));
    else if (!INVOICE_TYPE_CODES.has(code)) c.add('BR-KSA-05', `The invoice type code ${code} is not 388, 381, 383 or 386.`, pathOf(type, root));
    const name = type.hasAttribute('name') ? (type.getAttribute('name') ?? '').trim() : null;
    const namePath = `${pathOf(type, root)}/@name`;
    if (name === null || name === '') c.add('BR-KSA-06', 'The invoice type code has no name attribute (NNPNESB, for example 0100000 or 0200000).', namePath);
    else if (!TYPE_NAME_RE.test(name)) c.add('BR-KSA-06', `The invoice type code name ${name} is not 7 characters NNPNESB: 01 or 02, then five 0/1 flags.`, namePath);
  }

  const cur = c.text(root, 'cbc:DocumentCurrencyCode', { missing: 'BR-05', what: 'The document currency code (cbc:DocumentCurrencyCode)' });
  if (cur && !CURRENCY_RE.test(cur.value)) c.add('BR-05', `The document currency code ${cur.value} is not a 3-letter ISO 4217 code.`, pathOf(cur.el, root));

  c.text(root, 'cbc:TaxCurrencyCode', { missing: 'BR-KSA-68', what: 'The tax currency code (cbc:TaxCurrencyCode)' });
}

/** ICV, PIH and QR: AdditionalDocumentReference elements, each identified by its cbc:ID, each exactly once. */
function documentRefs(c: Check, root: Element): void {
  const refs = children(root, 'cac:AdditionalDocumentReference');
  const spec: { id: string; code: string; label: string; value: string }[] = [
    { id: 'ICV', code: 'BR-KSA-34', label: 'The invoice counter value (ICV)', value: 'cbc:UUID' },
    { id: 'PIH', code: 'BR-KSA-61', label: 'The previous invoice hash (PIH)', value: 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject' },
    { id: 'QR', code: 'BR-KSA-27', label: 'The QR code', value: 'cac:Attachment/cbc:EmbeddedDocumentBinaryObject' },
  ];
  for (const s of spec) {
    const hits = refs.filter((r) => clean(find(r, 'cbc:ID')) === s.id);
    const base = `cac:AdditionalDocumentReference[ID=${s.id}]`;
    if (hits.length === 0) {
      c.add(s.code, `${s.label} is missing: the invoice has no AdditionalDocumentReference with cbc:ID ${s.id}.`, base);
      continue;
    }
    for (const extra of hits.slice(1)) c.add(s.code, `${s.label} occurs ${hits.length} times; it must occur once.`, pathOf(extra, root));
    const ref = hits[0];
    const v = find(ref, s.value);
    if (!clean(v)) c.add(s.code, `${s.label} has no value (${s.value}).`, `${pathOf(ref, root)}/${s.value}`);
  }
}

function party(c: Check, root: Element, name: 'cac:AccountingSupplierParty' | 'cac:AccountingCustomerParty', required: boolean): void {
  const seller = name === 'cac:AccountingSupplierParty';
  const side = seller ? 'seller' : 'buyer';
  const codes = seller ? { name: 'BR-06', address: 'BR-08' } : { name: 'BR-KSA-42', address: 'BR-10' };
  const wrapper = c.one(root, name, { missing: null });
  if (!wrapper) {
    if (!required) return;
    if (seller) c.add('BR-06', `The seller (${name}) is missing.`, name);
    else {
      c.add(codes.name, `A standard invoice needs the buyer: ${name} is missing, so there is no buyer name.`, name);
      c.add(codes.address, `A standard invoice needs the buyer: ${name} is missing, so there is no buyer postal address.`, `${name}/cac:Party/cac:PostalAddress`);
    }
    return;
  }
  const base = pathOf(wrapper, root);
  const p = c.one(wrapper, 'cac:Party', { missing: null });
  if (!p) {
    if (required) {
      c.add(codes.name, `The ${side} has no cac:Party, so there is no ${side} name.`, `${base}/cac:Party`);
      c.add(codes.address, `The ${side} has no cac:Party, so there is no ${side} postal address.`, `${base}/cac:Party/cac:PostalAddress`);
    }
    return;
  }
  if (!required) return;
  const legal = c.one(p, 'cac:PartyLegalEntity', { missing: null });
  const nameEl = legal ? c.text(legal, 'cbc:RegistrationName', { missing: null }) : null;
  if (!nameEl) c.add(codes.name, `The ${side} name (cac:PartyLegalEntity/cbc:RegistrationName) is missing.`, `${pathOf(p, root)}/cac:PartyLegalEntity/cbc:RegistrationName`);
  const addr = c.one(p, 'cac:PostalAddress', { missing: null });
  if (!addr) {
    c.add(codes.address, `The ${side} postal address (cac:PostalAddress) is missing.`, `${pathOf(p, root)}/cac:PostalAddress`);
    return;
  }
  if (seller) {
    const country = c.one(addr, 'cac:Country', { missing: null });
    const codeEl = country ? c.text(country, 'cbc:IdentificationCode', { missing: null }) : null;
    if (!codeEl) c.add('BR-09', 'The seller country code (cac:Country/cbc:IdentificationCode) is missing.', `${pathOf(addr, root)}/cac:Country/cbc:IdentificationCode`);
  }
}

function taxTotals(c: Check, root: Element): void {
  const totals = children(root, 'cac:TaxTotal');
  const withBreakdown = totals.filter((t) => children(t, 'cac:TaxSubtotal').length > 0);
  const plain = totals.filter((t) => children(t, 'cac:TaxSubtotal').length === 0);
  if (totals.length > 2) c.add('XSD_ZATCA_INVALID', `The invoice has ${totals.length} cac:TaxTotal elements; ZATCA allows two (the tax currency total and the one with the VAT breakdown).`, pathOf(totals[2], root));
  if (withBreakdown.length > 1) c.add('XSD_ZATCA_INVALID', 'More than one cac:TaxTotal carries the VAT breakdown (cac:TaxSubtotal); only one may.', pathOf(withBreakdown[1], root));
  if (plain.length > 1) c.add('XSD_ZATCA_INVALID', 'More than one cac:TaxTotal has only a TaxAmount; only one may.', pathOf(plain[1], root));
  if (withBreakdown.length === 0) c.add('BR-CO-18', 'The invoice has no VAT breakdown: no cac:TaxTotal with a cac:TaxSubtotal.', 'cac:TaxTotal/cac:TaxSubtotal');

  for (const t of totals) {
    const amount = c.one(t, 'cbc:TaxAmount', { missing: 'XSD_ZATCA_INVALID', what: 'cbc:TaxAmount of cac:TaxTotal' });
    if (amount && !clean(amount)) c.add('XSD_ZATCA_INVALID', 'cbc:TaxAmount of cac:TaxTotal is empty.', pathOf(amount, root));
    c.currency(amount);
    for (const sub of children(t, 'cac:TaxSubtotal')) {
      c.currency(c.one(sub, 'cbc:TaxableAmount', { missing: 'XSD_ZATCA_INVALID', what: 'cbc:TaxableAmount of cac:TaxSubtotal' }));
      c.currency(c.one(sub, 'cbc:TaxAmount', { missing: 'XSD_ZATCA_INVALID', what: 'cbc:TaxAmount of cac:TaxSubtotal' }));
      c.one(sub, 'cac:TaxCategory', { missing: 'XSD_ZATCA_INVALID', what: 'cac:TaxCategory of cac:TaxSubtotal' });
    }
  }

  const taxCur = clean(find(root, 'cbc:TaxCurrencyCode'));
  if (taxCur && !plain.some((t) => clean(find(t, 'cbc:TaxAmount')) && find(t, 'cbc:TaxAmount')!.getAttribute('currencyID') === taxCur)) {
    c.add('BR-53', `TaxCurrencyCode is ${taxCur}, but there is no cac:TaxTotal with only a cbc:TaxAmount in ${taxCur} (the total VAT in the accounting currency).`, 'cac:TaxTotal/cbc:TaxAmount');
  }
}

function monetaryTotal(c: Check, root: Element): void {
  const lmt = c.one(root, 'cac:LegalMonetaryTotal', { missing: 'BR-13', what: 'The document totals (cac:LegalMonetaryTotal)' });
  if (!lmt) return;
  const amount = (name: string, code: string, what: string) => {
    const e = c.text(lmt, name, { missing: code, what });
    c.currency(e?.el ?? null);
  };
  amount('cbc:LineExtensionAmount', 'XSD_ZATCA_INVALID', 'The sum of line net amounts (cbc:LineExtensionAmount)');
  amount('cbc:TaxExclusiveAmount', 'BR-14', 'The total amount without VAT (cbc:TaxExclusiveAmount)');
  amount('cbc:TaxInclusiveAmount', 'BR-15', 'The total amount with VAT (cbc:TaxInclusiveAmount)');
  amount('cbc:PayableAmount', 'XSD_ZATCA_INVALID', 'The amount due for payment (cbc:PayableAmount)');
  for (const name of ['cbc:AllowanceTotalAmount', 'cbc:ChargeTotalAmount', 'cbc:PrepaidAmount', 'cbc:PayableRoundingAmount']) {
    const e = c.one(lmt, name, { missing: null });
    c.currency(e);
  }
}

function lines(c: Check, root: Element): void {
  const all = children(root, 'cac:InvoiceLine');
  if (all.length === 0) {
    c.add('BR-16', 'The invoice has no invoice line (cac:InvoiceLine).', 'cac:InvoiceLine');
    return;
  }
  for (const line of all) {
    const base = pathOf(line, root);
    c.text(line, 'cbc:ID', { missing: 'BR-21', what: 'The line identifier (cbc:ID)' });
    c.text(line, 'cbc:InvoicedQuantity', { missing: 'BR-22', what: 'The invoiced quantity (cbc:InvoicedQuantity)' });
    const net = c.text(line, 'cbc:LineExtensionAmount', { missing: 'BR-24', what: 'The line net amount (cbc:LineExtensionAmount)' });
    c.currency(net?.el ?? null);
    const item = c.one(line, 'cac:Item', { missing: null });
    if (!item) {
      c.add('BR-25', 'The line has no cac:Item, so no item name.', `${base}/cac:Item/cbc:Name`);
      c.add('BR-CO-04', 'The line has no cac:Item, so no VAT category.', `${base}/cac:Item/cac:ClassifiedTaxCategory/cbc:ID`);
    } else {
      c.text(item, 'cbc:Name', { missing: 'BR-25', what: 'The item name (cac:Item/cbc:Name)' });
      const cat = c.one(item, 'cac:ClassifiedTaxCategory', { missing: null });
      if (!cat) c.add('BR-CO-04', 'The line has no cac:ClassifiedTaxCategory (the VAT category).', `${pathOf(item, root)}/cac:ClassifiedTaxCategory/cbc:ID`);
      else c.text(cat, 'cbc:ID', { missing: 'BR-CO-04', what: 'The line VAT category code (cbc:ID)' });
    }
    const price = c.one(line, 'cac:Price', { missing: null });
    if (price) c.currency(c.one(price, 'cbc:PriceAmount', { missing: 'XSD_ZATCA_INVALID', what: 'cbc:PriceAmount of cac:Price' }));
  }
}

/** Phase 2 structure rules. Never throws for a malformed invoice: a shape it cannot read is a finding. */
export const structureRules: RuleModule = (ctx: RuleContext): RuleFinding[] => {
  const root = ctx.root;
  const c = new Check(root);
  rootChildren(c, root);
  header(c, root);
  documentRefs(c, root);
  party(c, root, 'cac:AccountingSupplierParty', true);
  party(c, root, 'cac:AccountingCustomerParty', ctx.extracted.docType === 'standard');
  taxTotals(c, root);
  monetaryTotal(c, root);
  lines(c, root);
  // A duplicate or a missing element can be reached by two checks: one finding per code and place.
  const seen = new Set<string>();
  return c.out.filter((f) => {
    const key = `${f.code}|${f.path ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
