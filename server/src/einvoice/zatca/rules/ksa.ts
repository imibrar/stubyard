import type { Element } from '@xmldom/xmldom';
import type { RuleContext, RuleModule } from '../validate.js';
import { tryParse } from '../dec.js';
import { ruleFinding, type RuleFinding } from './catalog.js';
import { NS, attr, children, descendants, find, findAll, isElement, text } from '../xml.js';

/**
 * Phase 2 field rules: the BR-KSA-* value rules (type code and name, seller and buyer identity and addresses, supply
 * date, credit / debit note fields, currencies, issue time and UUID), the general BR-* presence rules, the BR-DEC /
 * BR-KSA-DEC decimals and the BR-KSA-F-* format rules (dates, indicators, empty elements, signs, lengths).
 *
 * VAT arithmetic (vat.ts), the signature / QR (crypto.ts), the ICV / PIH chain (chain.ts) and the XML structure
 * (structure.ts) are other modules.
 */

const SELLER = 'cac:AccountingSupplierParty/cac:Party';
const BUYER = 'cac:AccountingCustomerParty/cac:Party';

const TYPE_CODES = new Set(['388', '381', '383', '386']);
const SELLER_SCHEMES = new Set(['CRN', 'MOM', 'MLS', '700', 'SAG', 'OTH']);
const VAT_CATEGORIES = new Set(['S', 'Z', 'E', 'O']);

const VAT_15 = /^\d{15}$/;
const KSA_VAT = /^3\d{13}3$/;
const UUID_CHARS = /^[A-Za-z0-9-]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(Z)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Riyadh is UTC+3 all year (no DST): "today" for BR-KSA-04. */
const KSA_OFFSET_MS = 3 * 3600_000;

/**
 * BR-KSA-F-06 maximum lengths: a subset of the ZATCA data dictionary (the values are assumed, as the dictionary is not
 * in the research notes).
 */
const MAX_LENGTHS: [path: string, max: number][] = [
  ['cbc:ID', 127],
  [`${SELLER}/cac:PartyLegalEntity/cbc:RegistrationName`, 1000],
  [`${SELLER}/cac:PostalAddress/cbc:StreetName`, 1000],
  [`${SELLER}/cac:PostalAddress/cbc:CitySubdivisionName`, 127],
  [`${SELLER}/cac:PostalAddress/cbc:CityName`, 127],
  [`${BUYER}/cac:PartyLegalEntity/cbc:RegistrationName`, 1000],
  [`${BUYER}/cac:PostalAddress/cbc:StreetName`, 1000],
  [`${BUYER}/cac:PostalAddress/cbc:CitySubdivisionName`, 127],
  [`${BUYER}/cac:PostalAddress/cbc:CityName`, 127],
  ['cac:PaymentMeans/cbc:InstructionNote', 1000],
  ['cac:InvoiceLine/cac:Item/cbc:Name', 1000],
];

const val = (el: Element, path: string): string | null => {
  const v = text(el, path)?.trim();
  return v ? v : null;
};

/** Every element that is a descendant of root (document order). */
function allElements(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (!isElement(n)) continue;
      out.push(n);
      walk(n);
    }
  };
  walk(root);
  return out;
}

/** "cac:InvoiceLine/cbc:ID" style path of an element below the root. */
function pathOf(el: Element, root: Element): string {
  const parts: string[] = [];
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentNode as Element | null) parts.unshift(cur.nodeName);
  return parts.join('/');
}

/** Inside ext:UBLExtensions (the signature): not invoice data. */
function inExtensions(el: Element): boolean {
  for (let cur = el.parentNode; cur && isElement(cur); cur = cur.parentNode) {
    if (cur.namespaceURI === NS.ext && cur.localName === 'UBLExtensions') return true;
  }
  return false;
}

const isCbc = (el: Element) => el.namespaceURI === NS.cbc;

/** A real calendar date in YYYY-MM-DD. */
function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Fraction digits as written ("12.500" → 3). */
const writtenPlaces = (s: string): number => {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};

/** The clock for BR-KSA-04: `nowMs` on the input when the pipeline passes one, else the wall clock. */
const nowOf = (ctx: RuleContext): number => {
  const n = (ctx.input as { nowMs?: unknown }).nowMs;
  return typeof n === 'number' && Number.isFinite(n) ? n : Date.now();
};

// --- invoice header ---

function header(ctx: RuleContext, out: RuleFinding[]): void {
  const { root, extracted: x } = ctx;

  if (x.uuid && !UUID_CHARS.test(x.uuid)) {
    out.push(ruleFinding('BR-KSA-03', `The invoice UUID "${x.uuid}" contains characters other than letters, digits and dashes.`, 'cbc:UUID'));
  }

  if (x.issueDate && validDate(x.issueDate)) {
    const today = new Date(nowOf(ctx) + KSA_OFFSET_MS).toISOString().slice(0, 10);
    if (x.issueDate > today) {
      out.push(ruleFinding('BR-KSA-04', `The issue date ${x.issueDate} is later than today (${today}, Riyadh time).`, 'cbc:IssueDate'));
    }
  }

  if (x.issueTime && !TIME_RE.test(x.issueTime)) {
    out.push(ruleFinding('BR-KSA-70', `The issue time "${x.issueTime}" is not hh:mm:ss or hh:mm:ssZ.`, 'cbc:IssueTime'));
  }

  if (x.typeCode && !TYPE_CODES.has(x.typeCode)) {
    out.push(ruleFinding('BR-KSA-05', `The invoice type code ${x.typeCode} is not 388, 381, 383 or 386.`, 'cbc:InvoiceTypeCode'));
  }

  const name = x.typeName;
  if (find(root, 'cbc:InvoiceTypeCode')) {
    if (!name || !/^0[12][0-9]{5}$/.test(name)) {
      out.push(ruleFinding('BR-KSA-06', `The invoice type code name "${name ?? ''}" does not follow NNPNESB (7 digits, starting 01 standard or 02 simplified).`, 'cbc:InvoiceTypeCode/@name'));
    } else {
      // NN P N E S B: type, third party, nominal, export, summary, self-billed.
      const flags = name.slice(2);
      if (!/^[01]{5}$/.test(flags)) {
        out.push(ruleFinding('BR-KSA-07', `The transaction flags "${flags}" of the invoice type code name ${name} shall each be 0 or 1.`, 'cbc:InvoiceTypeCode/@name'));
      } else {
        const exportFlag = flags[2] === '1';
        const selfBilled = flags[4] === '1';
        if (exportFlag && selfBilled) {
          out.push(ruleFinding('BR-KSA-07', `The invoice type code name ${name} sets both export and self-billed; a self-billed invoice cannot be an export invoice.`, 'cbc:InvoiceTypeCode/@name'));
        }
        if (name.startsWith('02') && (exportFlag || selfBilled)) {
          out.push(ruleFinding('BR-KSA-31', `The invoice type code name ${name} is a simplified invoice with the ${exportFlag ? 'export' : 'self-billed'} flag; simplified invoices cannot be export or self-billed invoices.`, 'cbc:InvoiceTypeCode/@name'));
        }
      }
    }
  }

  const taxCurrency = val(root, 'cbc:TaxCurrencyCode');
  if (taxCurrency !== 'SAR') {
    out.push(ruleFinding('BR-KSA-68', taxCurrency ? `The tax currency code is ${taxCurrency}; it shall be SAR.` : 'The invoice has no tax currency code (TaxCurrencyCode); it shall be SAR.', 'cbc:TaxCurrencyCode'));
  }
}

// --- general BR-* presence rules ---

function presence(ctx: RuleContext, out: RuleFinding[]): void {
  const { root, extracted: x } = ctx;
  const need = (code: string, path: string, what: string) => {
    if (!val(root, path)) out.push(ruleFinding(code, `The invoice has no ${what}.`, path));
  };
  need('BR-02', 'cbc:ID', 'invoice number (cbc:ID)');
  need('BR-03', 'cbc:IssueDate', 'issue date (cbc:IssueDate)');
  need('BR-04', 'cbc:InvoiceTypeCode', 'invoice type code (cbc:InvoiceTypeCode)');
  need('BR-05', 'cbc:DocumentCurrencyCode', 'invoice currency code (cbc:DocumentCurrencyCode)');
  need('BR-06', `${SELLER}/cac:PartyLegalEntity/cbc:RegistrationName`, 'seller name');
  if (!find(root, `${SELLER}/cac:PostalAddress`)) out.push(ruleFinding('BR-08', 'The invoice has no seller postal address.', `${SELLER}/cac:PostalAddress`));
  else need('BR-09', `${SELLER}/cac:PostalAddress/cac:Country/cbc:IdentificationCode`, 'seller country code');
  if (x.docType === 'standard' && !find(root, `${BUYER}/cac:PostalAddress`)) {
    out.push(ruleFinding('BR-10', 'The standard invoice has no buyer postal address.', `${BUYER}/cac:PostalAddress`));
  }

  const lmt = find(root, 'cac:LegalMonetaryTotal');
  if (!lmt) out.push(ruleFinding('BR-13', 'The invoice has no document totals (cac:LegalMonetaryTotal).', 'cac:LegalMonetaryTotal'));
  else {
    need('BR-14', 'cac:LegalMonetaryTotal/cbc:TaxExclusiveAmount', 'total amount without VAT (TaxExclusiveAmount)');
    need('BR-15', 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount', 'total amount with VAT (TaxInclusiveAmount)');
  }

  const lines = children(root, 'cac:InvoiceLine');
  if (!lines.length) out.push(ruleFinding('BR-16', 'The invoice has no invoice line.', 'cac:InvoiceLine'));
  lines.forEach((line, i) => {
    const at = `cac:InvoiceLine[${i + 1}]`;
    const lineNeed = (code: string, path: string, what: string) => {
      if (!val(line, path)) out.push(ruleFinding(code, `Invoice line ${i + 1} has no ${what}.`, `${at}/${path}`));
    };
    lineNeed('BR-21', 'cbc:ID', 'line identifier (cbc:ID)');
    lineNeed('BR-22', 'cbc:InvoicedQuantity', 'invoiced quantity');
    lineNeed('BR-24', 'cbc:LineExtensionAmount', 'line net amount (LineExtensionAmount)');
    lineNeed('BR-25', 'cac:Item/cbc:Name', 'item name');
  });

  findAll(root, 'cac:BillingReference').forEach((ref, i) => {
    if (!val(ref, 'cac:InvoiceDocumentReference/cbc:ID')) {
      out.push(ruleFinding('BR-55', `Billing reference ${i + 1} has no preceding invoice number (InvoiceDocumentReference/cbc:ID).`, `cac:BillingReference[${i + 1}]/cac:InvoiceDocumentReference/cbc:ID`));
    }
  });
}

// --- credit / debit notes and supply date ---

function documentKind(ctx: RuleContext, out: RuleFinding[]): void {
  const { root, extracted: x } = ctx;
  if (x.typeCode === '381' || x.typeCode === '383') {
    const kind = x.typeCode === '381' ? 'credit note' : 'debit note';
    if (!findAll(root, 'cac:BillingReference').length) {
      out.push(ruleFinding('BR-KSA-56', `The ${kind} has no billing reference (cac:BillingReference) to the original invoice.`, 'cac:BillingReference'));
    }
    const reasons = findAll(root, 'cac:PaymentMeans/cbc:InstructionNote').filter((n) => (n.textContent ?? '').trim());
    if (!reasons.length) {
      out.push(ruleFinding('BR-KSA-17', `The ${kind} has no reason for issuing it (PaymentMeans/InstructionNote).`, 'cac:PaymentMeans/cbc:InstructionNote'));
    }
  }
  if (x.docType === 'standard' && x.typeCode === '388' && !val(root, 'cac:Delivery/cbc:ActualDeliveryDate')) {
    out.push(ruleFinding('BR-KSA-15', 'The standard invoice has no supply date (cac:Delivery/cbc:ActualDeliveryDate).', 'cac:Delivery/cbc:ActualDeliveryDate'));
  }
}

// --- seller ---

function seller(ctx: RuleContext, out: RuleFinding[]): void {
  const { root, extracted: x } = ctx;
  const vatPath = `${SELLER}/cac:PartyTaxScheme/cbc:CompanyID`;
  if (x.sellerVat) {
    if (!VAT_15.test(x.sellerVat)) {
      out.push(ruleFinding('BR-KSA-39', `The seller VAT number "${x.sellerVat}" is not 15 digits (it has ${x.sellerVat.length} characters).`, vatPath));
    } else if (!KSA_VAT.test(x.sellerVat)) {
      out.push(ruleFinding('BR-KSA-40', `The seller VAT number ${x.sellerVat} does not start and end with 3.`, vatPath));
    }
  } else if (find(root, SELLER)) {
    out.push(ruleFinding('BR-KSA-39', 'The seller has no VAT number (PartyTaxScheme/CompanyID).', vatPath));
  }

  const party = find(root, SELLER);
  if (party) {
    const ids = children(party, 'cac:PartyIdentification').map((p) => find(p, 'cbc:ID')).filter((e): e is Element => !!e);
    const idPath = `${SELLER}/cac:PartyIdentification/cbc:ID`;
    if (!ids.length) out.push(ruleFinding('BR-KSA-08', 'The seller has no other identification (PartyIdentification/cbc:ID with a schemeID of CRN, MOM, MLS, 700, SAG or OTH).', idPath));
    for (const id of ids) {
      const scheme = attr(id, 'schemeID')?.trim() ?? '';
      if (!SELLER_SCHEMES.has(scheme)) {
        out.push(ruleFinding('BR-KSA-08', `The seller identification scheme "${scheme}" is not one of CRN, MOM, MLS, 700, SAG or OTH.`, `${idPath}/@schemeID`));
      } else if (!(id.textContent ?? '').trim()) {
        out.push(ruleFinding('BR-KSA-08', `The seller identification with scheme ${scheme} has no value.`, idPath));
      } else if (!/^[A-Za-z0-9]+$/.test((id.textContent ?? '').trim())) {
        out.push(ruleFinding('BR-KSA-08', `The seller identification "${(id.textContent ?? '').trim()}" (scheme ${scheme}) shall contain only letters and digits.`, idPath));
      }
    }
  }

  const addr = find(root, `${SELLER}/cac:PostalAddress`);
  if (!addr) return;
  const base = `${SELLER}/cac:PostalAddress`;
  const fields: [path: string, what: string][] = [
    ['cbc:StreetName', 'street name'],
    ['cbc:BuildingNumber', 'building number'],
    ['cbc:PostalZone', 'postal code'],
    ['cbc:CityName', 'city'],
    ['cbc:CitySubdivisionName', 'district'],
    ['cac:Country/cbc:IdentificationCode', 'country code'],
  ];
  for (const [path, what] of fields) {
    if (!val(addr, path)) out.push(ruleFinding('BR-KSA-09', `The seller address has no ${what}.`, `${base}/${path}`));
  }
  const building = val(addr, 'cbc:BuildingNumber');
  if (building && !/^\d{4}$/.test(building)) {
    out.push(ruleFinding('BR-KSA-37', `The seller building number "${building}" is not 4 digits.`, `${base}/cbc:BuildingNumber`));
  }
  const postal = val(addr, 'cbc:PostalZone');
  if (postal && !/^\d{5}$/.test(postal)) {
    out.push(ruleFinding('BR-KSA-66', `The seller postal code "${postal}" is not 5 digits.`, `${base}/cbc:PostalZone`));
  }
}

// --- buyer ---

function buyer(ctx: RuleContext, out: RuleFinding[]): void {
  const { root, extracted: x } = ctx;
  const standard = x.docType === 'standard';
  const party = find(root, BUYER);

  if (standard && !x.buyerName) {
    out.push(ruleFinding('BR-KSA-42', 'The standard invoice has no buyer name (PartyLegalEntity/RegistrationName).', `${BUYER}/cac:PartyLegalEntity/cbc:RegistrationName`));
  }

  if (x.buyerVat && !KSA_VAT.test(x.buyerVat)) {
    out.push(ruleFinding('BR-KSA-44', `The buyer VAT number "${x.buyerVat}" is not 15 digits starting and ending with 3.`, `${BUYER}/cac:PartyTaxScheme/cbc:CompanyID`));
  }

  if (standard && party && !x.buyerVat) {
    const ok = children(party, 'cac:PartyIdentification').some((p) => {
      const id = find(p, 'cbc:ID');
      return !!id && !!(id.textContent ?? '').trim() && !!attr(id, 'schemeID')?.trim();
    });
    if (!ok) {
      out.push(ruleFinding('BR-KSA-81', 'The buyer has no VAT number and no other identification (PartyIdentification/cbc:ID with a schemeID).', `${BUYER}/cac:PartyIdentification/cbc:ID`));
    }
  }

  const base = `${BUYER}/cac:PostalAddress`;
  const addr = find(root, base);
  if (standard && !addr) {
    out.push(ruleFinding('BR-KSA-10', 'The standard invoice has no buyer postal address.', base));
    return;
  }
  if (!addr || val(addr, 'cac:Country/cbc:IdentificationCode') !== 'SA') return;

  if (standard) {
    const fields: [path: string, what: string][] = [
      ['cbc:StreetName', 'street name'],
      ['cbc:CityName', 'city'],
      ['cbc:CitySubdivisionName', 'district'],
      ['cbc:PostalZone', 'postal code'],
    ];
    for (const [path, what] of fields) {
      if (!val(addr, path)) out.push(ruleFinding('BR-KSA-67', `The Saudi buyer address has no ${what}.`, `${base}/${path}`));
    }
  }
  const building = val(addr, 'cbc:BuildingNumber');
  if (building ? !/^\d{4}$/.test(building) : standard) {
    out.push(ruleFinding('BR-KSA-63', building ? `The Saudi buyer building number "${building}" is not 4 digits.` : 'The Saudi buyer address has no building number.', `${base}/cbc:BuildingNumber`));
  }
  const postal = val(addr, 'cbc:PostalZone');
  if (postal && !/^\d{5}$/.test(postal)) {
    out.push(ruleFinding('BR-KSA-63', `The Saudi buyer postal code "${postal}" is not 5 digits.`, `${base}/cbc:PostalZone`));
  }
}

// --- VAT category codes ---

function categories(ctx: RuleContext, out: RuleFinding[]): void {
  const cats = [...descendants(ctx.root, 'cac:TaxCategory'), ...descendants(ctx.root, 'cac:ClassifiedTaxCategory')];
  for (const c of cats) {
    const id = find(c, 'cbc:ID');
    const code = id ? (id.textContent ?? '').trim() : '';
    if (!VAT_CATEGORIES.has(code)) {
      out.push(ruleFinding('BR-KSA-18', `The VAT category code "${code}" is not S, Z, E or O.`, `${pathOf(c, ctx.root)}/cbc:ID`));
    }
  }
}

// --- decimals (BR-DEC, BR-KSA-DEC) ---

/** The BR-DEC code of an amount element, from its name and parent; BR-KSA-DEC-01 for the other amounts. */
function decCode(el: Element): string | null {
  const parent = el.parentNode as Element | null;
  const p = parent?.localName ?? '';
  const gp = (parent?.parentNode as Element | null)?.localName ?? '';
  const n = el.localName ?? '';
  if (n === 'PriceAmount') return null; // BR-KSA-DEC-03: the allowed decimals of the price are not known
  if (p === 'LegalMonetaryTotal') {
    const map: Record<string, string> = {
      LineExtensionAmount: 'BR-DEC-09', AllowanceTotalAmount: 'BR-DEC-14', ChargeTotalAmount: 'BR-DEC-15',
      TaxExclusiveAmount: 'BR-DEC-16', TaxInclusiveAmount: 'BR-DEC-19', PrepaidAmount: 'BR-DEC-20',
    };
    return map[n] ?? 'BR-KSA-DEC-01';
  }
  if (p === 'AllowanceCharge' && parent) {
    const charge = val(parent, 'cbc:ChargeIndicator') === 'true';
    if (gp === 'Invoice') {
      if (n === 'Amount') return charge ? 'BR-DEC-12' : 'BR-DEC-10';
      if (n === 'BaseAmount') return charge ? 'BR-DEC-13' : 'BR-DEC-11';
    }
    if (gp === 'InvoiceLine' && n === 'Amount') return charge ? 'BR-DEC-25' : 'BR-DEC-24';
    if (gp === 'Price') {
      if (n === 'Amount') return 'BR-DEC-27';
      if (n === 'BaseAmount') return 'BR-DEC-28';
    }
  }
  if (p === 'InvoiceLine' && n === 'LineExtensionAmount') return 'BR-DEC-23';
  if (p === 'TaxTotal' && gp === 'Invoice' && n === 'TaxAmount' && parent) {
    // The TaxTotal with the breakdown is BT-110; the one without it is the VAT in accounting currency (BT-111).
    return children(parent, 'cac:TaxSubtotal').length ? 'BR-DEC-17' : 'BR-DEC-18';
  }
  return 'BR-KSA-DEC-01';
}

function decimals(ctx: RuleContext, out: RuleFinding[]): void {
  for (const el of allElements(ctx.root)) {
    if (!isCbc(el) || inExtensions(el)) continue;
    const v = (el.textContent ?? '').trim();
    if (!v || !tryParse(v).ok) continue;
    if (el.hasAttribute('currencyID')) {
      const code = decCode(el);
      if (code && writtenPlaces(v) > 2) out.push(ruleFinding(code, `The amount ${el.nodeName} = ${v} has more than 2 decimals.`, pathOf(el, ctx.root)));
    } else if (el.localName === 'Percent') {
      const n = Number(v);
      if (n < 0 || n > 100) out.push(ruleFinding('BR-KSA-DEC-02', `The VAT percentage ${v} is not between 0 and 100.`, pathOf(el, ctx.root)));
    }
  }
}

// --- formats (BR-KSA-F) ---

function formats(ctx: RuleContext, out: RuleFinding[]): void {
  const { root } = ctx;
  for (const el of allElements(root)) {
    if (!isCbc(el) || inExtensions(el)) continue;
    const v = (el.textContent ?? '').trim();
    const at = pathOf(el, root);
    if (!v) {
      out.push(ruleFinding('BR-KSA-F-03', `The element ${el.nodeName} is empty.`, at));
      continue;
    }
    if ((el.localName ?? '').endsWith('Date') && !validDate(v)) {
      out.push(ruleFinding('BR-KSA-F-01', `The date ${el.nodeName} = "${v}" is not a valid YYYY-MM-DD date.`, at));
    }
    if ((el.localName ?? '').endsWith('Indicator') && v !== 'true' && v !== 'false') {
      out.push(ruleFinding('BR-KSA-F-02', `The indicator ${el.nodeName} = "${v}" is not true or false.`, at));
    }
    const amountOrQty = el.hasAttribute('currencyID') || el.localName === 'InvoicedQuantity' || el.localName === 'BaseQuantity';
    if (amountOrQty) {
      const d = tryParse(v);
      if (!d.ok) out.push(ruleFinding('BR-KSA-F-04', `The ${el.hasAttribute('currencyID') ? 'amount' : 'quantity'} ${el.nodeName} = "${v}" is not a number.`, at));
      else if (d.value < 0n) out.push(ruleFinding('BR-KSA-F-04', `The ${el.hasAttribute('currencyID') ? 'amount' : 'quantity'} ${el.nodeName} = ${v} is negative.`, at));
    }
  }
  for (const [path, max] of MAX_LENGTHS) {
    findAll(root, path).forEach((el) => {
      const v = (el.textContent ?? '').trim();
      if (v.length > max) out.push(ruleFinding('BR-KSA-F-06', `${path} is ${v.length} characters long; the maximum is ${max}.`, path));
    });
  }
}

/** The KSA / BR / F field rules of one invoice. */
export const ksaRules: RuleModule = (ctx) => {
  const out: RuleFinding[] = [];
  header(ctx, out);
  presence(ctx, out);
  documentKind(ctx, out);
  seller(ctx, out);
  buyer(ctx, out);
  categories(ctx, out);
  decimals(ctx, out);
  formats(ctx, out);
  return out;
};
