/**
 * ZATCA rule catalog: every code stubyard can put into `validationResults`.
 *
 * Severity assumption: ZATCA does not publish which rule is an error and which a warning. Warnings are the ones seen
 * as warnings in the forum (BR-CO-17, BR-53), the secondary-document length rule BR-KSA-F-06, and nothing else;
 * everything else is an error (the invoice is rejected with 400). Late reporting is a stubyard lint
 * (`einv.reported-late`), not a ZATCA rule.
 *
 * `verified` is true only where docs/plans/research-zatca.md marks the code or its meaning Verified (ZATCA's own
 * standards PDFs) or Forum (seen in the ZATCA developer community). The message text is stubyard's own short English
 * paraphrase, not ZATCA's exact wording, except for the codes with a quoted message in the research notes.
 */

export type RuleSeverity = 'error' | 'warning';
export type RuleCategory =
  | 'XSD validation'
  | 'KSA'
  | 'EN_16931'
  | 'INVOICE_HASHING_ERRORS'
  | 'CERTIFICATE_ERRORS'
  | 'QRCODE_ERRORS'
  | 'INVOICE_ERRORS';

export interface ZatcaRule {
  code: string;
  category: RuleCategory;
  severity: RuleSeverity;
  message: string;
  verified: boolean;
}

/** One finding of the rule engine (before it becomes a validationResults message and a lint finding). */
export interface RuleFinding {
  code: string;
  category: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** XPath-like location in the invoice, when known. */
  path?: string;
}

type Row = [code: string, message: string, verified?: boolean];

const WARNINGS = new Set(['BR-CO-17', 'BR-53', 'BR-KSA-F-06']);

function rows(category: RuleCategory, list: Row[]): ZatcaRule[] {
  return list.map(([code, message, verified]) => ({
    code,
    category,
    severity: WARNINGS.has(code) ? 'warning' : 'error',
    message,
    verified: verified === true,
  }));
}

const V = true;

export const ZATCA_RULES: readonly ZatcaRule[] = [
  ...rows('XSD validation', [
    ['XSD_ZATCA_INVALID', 'The invoice is not valid against the UBL 2.1 structure required by ZATCA (well-formed XML, Invoice root in the UBL namespace, required elements in UBL order).'],
  ]),
  ...rows('EN_16931', [
    ['BR-02', 'An invoice shall have an invoice number (BT-1).'],
    ['BR-03', 'An invoice shall have an issue date (BT-2).'],
    ['BR-04', 'An invoice shall have an invoice type code (BT-3).'],
    ['BR-05', 'An invoice shall have an invoice currency code (BT-5).'],
    ['BR-06', 'An invoice shall contain the seller name (BT-27).'],
    ['BR-08', 'An invoice shall contain the seller postal address (BG-5).'],
    ['BR-09', 'The seller postal address shall contain a country code (BT-40).'],
    ['BR-10', 'A standard invoice shall contain the buyer postal address (BG-8).'],
    ['BR-13', 'An invoice shall have the document level amounts (BG-22).'],
    ['BR-14', 'An invoice shall have the total amount without VAT (BT-109).'],
    ['BR-15', 'An invoice shall have the total amount with VAT (BT-112).'],
    ['BR-16', 'An invoice shall have at least one invoice line (BG-25).'],
    ['BR-21', 'Each invoice line shall have an invoice line identifier (BT-126).'],
    ['BR-22', 'Each invoice line shall have an invoiced quantity (BT-129).'],
    ['BR-24', 'Each invoice line shall have an invoice line net amount (BT-131).'],
    ['BR-25', 'Each invoice line shall contain the item name (BT-153).'],
    ['BR-53', 'If a VAT accounting currency code (BT-6) is present, the invoice total VAT amount in accounting currency (BT-111) shall be present.', V],
    ['BR-55', 'Each preceding invoice reference shall contain a preceding invoice number (BT-25).'],
    ['BR-CO-04', 'Each invoice line shall be categorized with an invoiced item VAT category code (BT-151).'],
    ['BR-CO-10', 'Sum of invoice line net amount (BT-106) shall equal the sum of the invoice line net amounts (BT-131).', V],
    ['BR-CO-11', 'Sum of allowances on document level (BT-107) shall equal the sum of the document level allowance amounts (BT-92).', V],
    ['BR-CO-12', 'Sum of charges on document level (BT-108) shall equal the sum of the document level charge amounts (BT-99).', V],
    ['BR-CO-13', 'Invoice total amount without VAT (BT-109) shall equal BT-106 minus BT-107 plus BT-108.', V],
    ['BR-CO-14', 'Invoice total VAT amount (BT-110) shall equal the sum of the VAT category tax amounts (BT-117).', V],
    ['BR-CO-15', 'Invoice total amount with VAT (BT-112) shall equal BT-109 plus BT-110.', V],
    ['BR-CO-16', 'Amount due for payment (BT-115) shall equal BT-112 minus the prepaid amount (BT-113) plus the rounding amount (BT-114).', V],
    ['BR-CO-17', 'VAT category tax amount (BT-117) shall equal the VAT category taxable amount (BT-116) times the rate (BT-119) divided by 100, rounded to two decimals.', V],
    ['BR-CO-18', 'An invoice shall have at least one VAT breakdown group (BG-23).', V],
    ['BR-S-05', 'In an invoice line with VAT category S the invoiced item VAT rate (BT-152) shall be greater than zero.'],
    ['BR-S-08', 'For each VAT category S the VAT category taxable amount (BT-116) shall equal the sum of the line net amounts of that category minus the allowances plus the charges.'],
    ['BR-S-09', 'The VAT category tax amount (BT-117) of category S shall equal the taxable amount times the rate divided by 100.'],
    ['BR-Z-05', 'In an invoice line with VAT category Z the invoiced item VAT rate (BT-152) shall be 0.'],
    ['BR-Z-08', 'For each VAT category Z the VAT category taxable amount (BT-116) shall equal the sum of the line net amounts of that category minus the allowances plus the charges.'],
    ['BR-Z-09', 'The VAT category tax amount (BT-117) of category Z shall be 0.'],
    ['BR-E-05', 'In an invoice line with VAT category E the invoiced item VAT rate (BT-152) shall be 0.'],
    ['BR-E-08', 'For each VAT category E the VAT category taxable amount (BT-116) shall equal the sum of the line net amounts of that category minus the allowances plus the charges.'],
    ['BR-E-09', 'The VAT category tax amount (BT-117) of category E shall be 0.'],
    ['BR-O-05', 'In an invoice line with VAT category O no invoiced item VAT rate (BT-152) shall be present.'],
    ['BR-O-08', 'For each VAT category O the VAT category taxable amount (BT-116) shall equal the sum of the line net amounts of that category minus the allowances plus the charges.'],
    ['BR-O-09', 'The VAT category tax amount (BT-117) of category O shall be 0.'],
    ['BR-DEC-09', 'The sum of invoice line net amount (BT-106) shall have at most 2 decimals.'],
    ['BR-DEC-10', 'The document level allowance amount (BT-92) shall have at most 2 decimals.'],
    ['BR-DEC-11', 'The document level allowance base amount (BT-93) shall have at most 2 decimals.'],
    ['BR-DEC-12', 'The document level charge amount (BT-99) shall have at most 2 decimals.'],
    ['BR-DEC-13', 'The document level charge base amount (BT-100) shall have at most 2 decimals.'],
    ['BR-DEC-14', 'The sum of allowances on document level (BT-107) shall have at most 2 decimals.'],
    ['BR-DEC-15', 'The sum of charges on document level (BT-108) shall have at most 2 decimals.'],
    ['BR-DEC-16', 'The invoice total amount without VAT (BT-109) shall have at most 2 decimals.'],
    ['BR-DEC-17', 'The invoice total VAT amount (BT-110) shall have at most 2 decimals.'],
    ['BR-DEC-18', 'The invoice total VAT amount in accounting currency (BT-111) shall have at most 2 decimals.'],
    ['BR-DEC-19', 'The invoice total amount with VAT (BT-112) shall have at most 2 decimals.'],
    ['BR-DEC-20', 'The prepaid amount (BT-113) shall have at most 2 decimals.'],
    ['BR-DEC-23', 'The invoice line net amount (BT-131) shall have at most 2 decimals.'],
    ['BR-DEC-24', 'The invoice line allowance amount (BT-136) shall have at most 2 decimals.'],
    ['BR-DEC-25', 'The invoice line charge amount (BT-141) shall have at most 2 decimals.'],
    ['BR-DEC-27', 'The item price discount (BT-147) shall have at most 2 decimals.'],
    ['BR-DEC-28', 'The item gross price (BT-148) shall have at most 2 decimals.'],
  ]),
  ...rows('KSA', [
    ['BR-KSA-03', 'The invoice UUID may contain only letters, digits and dashes.', V],
    ['BR-KSA-04', 'The invoice issue date shall not be later than today.', V],
    ['BR-KSA-05', 'The invoice type code shall be 388 (invoice), 381 (credit note), 383 (debit note) or 386 (prepayment).', V],
    ['BR-KSA-06', 'The invoice type code name shall follow the NNPNESB pattern (01 standard or 02 simplified, then the flags).', V],
    ['BR-KSA-07', 'The invoice transaction flags (third party, nominal, export, summary, self-billed) shall be 0 or 1 and consistent with the invoice type.', V],
    ['BR-KSA-08', 'The seller identification scheme shall be one of CRN, MOM, MLS, 700, SAG or OTH.', V],
    ['BR-KSA-09', 'The seller address shall contain street, building number, postal code, city, district and country.', V],
    ['BR-KSA-10', 'A standard invoice shall contain the buyer postal address.', V],
    ['BR-KSA-15', 'A standard invoice (388) shall contain the supply date.', V],
    ['BR-KSA-17', 'A credit or debit note shall contain the reason for issuing it.', V],
    ['BR-KSA-18', 'The VAT category code shall be S, Z, E or O.', V],
    ['BR-KSA-23', 'A VAT category E line or breakdown shall carry an exemption reason code from the allowed list.', V],
    ['BR-KSA-24', 'A VAT category E breakdown shall carry an exemption reason text matching its reason code.', V],
    ['BR-KSA-25', 'The invoice header shall carry the mandatory ZATCA fields in the required form.'],
    ['BR-KSA-26', 'The previous invoice hash (PIH) shall be the hash of the previous invoice; the first invoice uses the fixed first-PIH value.', V],
    ['BR-KSA-27', 'The invoice shall contain the QR code as an additional document reference with ID QR.', V],
    ['BR-KSA-28', 'The signature ID shall be urn:oasis:names:specification:ubl:signature:Invoice.', V],
    ['BR-KSA-29', 'The signature method shall be urn:oasis:names:specification:ubl:dsig:enveloped:xades.', V],
    ['BR-KSA-30', 'The signature information ID shall be urn:oasis:names:specification:ubl:signature:1.', V],
    ['BR-KSA-31', 'The invoice type flags shall be valid for the invoice type (for example a simplified invoice cannot be an export).', V],
    ['BR-KSA-33', 'The invoice counter value (ICV) shall contain digits only.', V],
    ['BR-KSA-34', 'The invoice shall contain the invoice counter value (ICV).', V],
    ['BR-KSA-37', 'The seller building number shall be 4 digits.', V],
    ['BR-KSA-39', 'The seller VAT number shall be 15 digits.', V],
    ['BR-KSA-40', 'The seller VAT number shall start and end with 3.', V],
    ['BR-KSA-42', 'A standard invoice shall contain the buyer name.', V],
    ['BR-KSA-44', 'The buyer VAT number shall be 15 digits starting and ending with 3.', V],
    ['BR-KSA-51', 'The invoice line VAT amount shall be consistent with the line net amount and the VAT rate.', V],
    ['BR-KSA-52', 'The invoice line amount including VAT shall equal the line net amount plus the line VAT amount.', V],
    ['BR-KSA-53', 'The invoice line RoundingAmount shall equal the line net amount plus the line VAT amount.', V],
    ['BR-KSA-56', 'A credit or debit note shall contain a billing reference to the original invoice.', V],
    ['BR-KSA-60', 'A simplified invoice shall contain the signature.', V],
    ['BR-KSA-61', 'The invoice shall contain the previous invoice hash (PIH).', V],
    ['BR-KSA-63', 'The buyer address of a Saudi buyer shall contain a 4-digit building number and a 5-digit postal code.', V],
    ['BR-KSA-66', 'The seller postal code shall be 5 digits.', V],
    ['BR-KSA-67', 'The buyer address of a Saudi buyer shall contain street, city, district and postal code.', V],
    ['BR-KSA-68', 'The tax currency code (TaxCurrencyCode) shall be SAR.', V],
    ['BR-KSA-69', 'A VAT category Z breakdown shall carry an exemption reason code from the allowed list.', V],
    ['BR-KSA-70', 'The issue time shall be hh:mm:ss or hh:mm:ssZ.', V],
    ['BR-KSA-81', 'A buyer without a VAT number shall be identified by another ID (scheme and value).', V],
    ['BR-KSA-83', 'A VAT category O breakdown shall carry an exemption reason code from the allowed list.', V],
    ['BR-KSA-DEC-01', 'The amounts of the invoice shall have at most 2 decimals.'],
    ['BR-KSA-DEC-02', 'A VAT percentage shall be between 0 and 100.'],
    ['BR-KSA-DEC-03', 'The invoice line quantity and price shall have at most the decimals ZATCA allows.'],
    ['BR-KSA-F-01', 'Dates shall use the format YYYY-MM-DD.', V],
    ['BR-KSA-F-02', 'Indicators shall be the text true or false.', V],
    ['BR-KSA-F-03', 'The invoice shall not contain empty elements.', V],
    ['BR-KSA-F-04', 'Amounts and quantities shall be positive.', V],
    ['BR-KSA-F-06', 'A text field is longer than the maximum length in the ZATCA data dictionary.', V],
  ]),
  ...rows('INVOICE_HASHING_ERRORS', [
    ['invalid-invoice-hash', 'The invoice hash API body does not match the (calculated) Hash of the XML', V],
  ]),
  ...rows('CERTIFICATE_ERRORS', [
    ['signed-properties-hashing', "Invalid signed properties hashing, SignedProperties with id='xadesSignedProperties'", V],
    ['certificate-mismatch', 'The certificate in the invoice signature is not the certificate of the CSID used for the request.'],
    ['invalid-signature', 'The invoice signature does not verify with the certificate public key.'],
  ]),
  ...rows('INVOICE_ERRORS', [
    ['invalid-uuid', 'The uuid in the request body does not match the UUID of the XML invoice.'],
  ]),
  ...rows('QRCODE_ERRORS', [
    ['QRCODE_INVALID', 'The QR code is missing, cannot be decoded, or its tags do not match the invoice.'],
  ]),
];

const BY_CODE = new Map(ZATCA_RULES.map((r) => [r.code, r]));
const BY_CODE_LOWER = new Map(ZATCA_RULES.map((r) => [r.code.toLowerCase(), r]));

/** The rule with this code (exact match). */
export const ruleByCode = (code: string): ZatcaRule | undefined => BY_CODE.get(code);

/** The rule with this code, ignoring case (fault specs are typed by hand). */
export const ruleByCodeLoose = (code: string): ZatcaRule | undefined => BY_CODE_LOWER.get(String(code).trim().toLowerCase());

/** A finding for a catalog code (the message can be overridden with a more specific one). */
export function ruleFinding(code: string, message?: string, path?: string): RuleFinding {
  const r = BY_CODE.get(code);
  if (!r) throw new Error(`Unknown ZATCA rule code "${code}"`);
  return { code: r.code, category: r.category, severity: r.severity, message: message ?? r.message, ...(path ? { path } : {}) };
}
