import type { Element } from '@xmldom/xmldom';
import { finding, type EinvoiceLintFinding } from '../../lint.js';
import { canonicalize } from '../c14n.js';
import { tryParse } from '../dec.js';
import { hashVariants, sha256b64, sha256hexb64 } from '../hash.js';
import { certHashVariants, certInfo, certIssuedBy, ecdsaVerify, toPem, type CertInfo } from '../pki.js';
import { asBase64, decodeTlv, type DecodedTlv } from '../qr.js';
import type { RuleContext, RuleModule } from '../validate.js';
import { attr, children, descendants, find, text } from '../xml.js';
import { ruleFinding, type RuleFinding } from './catalog.js';

/**
 * Phase 2 crypto and QR rules: the XAdES signature (invoice digest, ECDSA signature value, SignedProperties digest),
 * the signing certificate (issued by the instance CA, the CSID of the request, CertDigest / IssuerSerial) and the QR
 * tags against the XML.
 *
 * Accepted variants (no finding; an `einv.signature-variant` lint warning names the variant, except the signature input,
 * which is always noted with `einv.signature-method`):
 * - the signature over the invoice hash bytes (what the SDKs do) or over the canonical SignedInfo (XMLDSig);
 * - the SignedProperties digest as base64(hex(sha256)) (ZATCA's quirk) or base64(raw sha256), over the inclusive C14N
 *   of the element in place, its exclusive C14N, or its text as written;
 * - the SignedProperties Reference Type xmldsig#SignatureProperties instead of 01903#SignedProperties;
 * - every certHashVariants() form of the CertDigest.
 *
 * A missing QR is BR-KSA-27 (the KSA module); a missing signature on a standard invoice is not an error.
 */

const SIG_PATH = 'ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent/sig:UBLDocumentSignatures/sac:SignatureInformation/ds:Signature';
const SP_TYPE = 'http://uri.etsi.org/01903#SignedProperties';
const SP_TYPE_ALT = 'http://www.w3.org/2000/09/xmldsig#SignatureProperties';
const QR_PATH = 'cac:AdditionalDocumentReference[ID=QR]';
const SIG_VALUE_PATH = 'ds:Signature/ds:SignatureValue';

export interface CryptoResult {
  findings: RuleFinding[];
  /** stubyard-only lint (`einv.*`): the accepted variants and the signature input. */
  lint: EinvoiceLintFinding[];
}

const strip = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, '');

/** The ds:Signature of the invoice (in UBLExtensions; any ds:Signature as a fallback). */
function dsSignature(ctx: RuleContext): Element | null {
  return find(ctx.root, SIG_PATH) ?? descendants(ctx.doc, 'ds:Signature')[0] ?? null;
}

/** "CN=a, O=b, C=SA" or "C=SA\nO=b\nCN=a" → a sorted list of normalised RDNs, for an order-insensitive compare. */
function dnParts(dn: string): string[] {
  return dn
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? p : `${p.slice(0, i).trim().toUpperCase()}=${p.slice(i + 1).trim()}`;
    })
    .sort();
}

const sameDn = (a: string, b: string): boolean => dnParts(a).join('\n') === dnParts(b).join('\n');

function decimalSerial(v: string): bigint | null {
  try {
    return /^\d+$/.test(v) ? BigInt(v) : null;
  } catch {
    return null;
  }
}

/** Equal as decimals when both parse, else as trimmed text. */
function sameAmount(a: string, b: string): boolean {
  const x = tryParse(a.trim());
  const y = tryParse(b.trim());
  return x.ok && y.ok ? x.value === y.value : a.trim() === b.trim();
}

const noZ = (s: string): string => s.trim().replace(/Z$/i, '');

/** The crypto and QR findings of one invoice, with the lint notes for accepted variants. */
export function cryptoChecks(ctx: RuleContext): CryptoResult {
  const findings: RuleFinding[] = [];
  const lint: EinvoiceLintFinding[] = [];
  const x = ctx.extracted;
  const computed = x.computedHash;
  const sig = dsSignature(ctx);
  const simplified = x.docType === 'simplified';

  let certPem: string | null = null;
  let info: CertInfo | null = null;
  let signatureValue: string | null = null;

  if (!sig) {
    if (simplified) findings.push(ruleFinding('BR-KSA-60', 'A simplified invoice shall contain the signature: there is no ds:Signature in ext:UBLExtensions.', 'ext:UBLExtensions'));
  } else {
    // --- the signing certificate ---
    const certB64 = strip(text(sig, 'ds:KeyInfo/ds:X509Data/ds:X509Certificate'));
    if (!certB64) {
      findings.push(ruleFinding('certificate-mismatch', 'The signature has no certificate (ds:KeyInfo/ds:X509Data/ds:X509Certificate).', 'ds:KeyInfo/ds:X509Data/ds:X509Certificate'));
    } else {
      try {
        certPem = toPem(Buffer.from(certB64, 'base64'), 'CERTIFICATE');
        info = certInfo(certPem);
      } catch {
        certPem = null;
        info = null;
        findings.push(ruleFinding('certificate-mismatch', 'The certificate in ds:X509Certificate cannot be read as an X.509 certificate.', 'ds:KeyInfo/ds:X509Data/ds:X509Certificate'));
      }
    }
    if (certPem && info) findings.push(...certFindings(ctx, certPem, info));

    // --- SignedInfo references and the signature value ---
    signatureValue = strip(text(sig, 'ds:SignatureValue')) || null;
    const signedInfo = children(sig, 'ds:SignedInfo')[0] ?? null;
    const refs = signedInfo ? children(signedInfo, 'ds:Reference') : [];
    const invoiceRef = refs.find((r) => attr(r, 'URI') === '') ?? null;
    const digest = invoiceRef ? strip(text(invoiceRef, 'ds:DigestValue')) : '';

    const sigProblems: string[] = [];
    if (!signedInfo) sigProblems.push('there is no ds:SignedInfo');
    else if (!invoiceRef) sigProblems.push('ds:SignedInfo has no invoice reference (ds:Reference URI="")');
    let digestVariant: string | undefined;
    if (invoiceRef && computed && digest !== computed) {
      try {
        digestVariant = hashVariants(ctx.xml).find((v) => v.hash === digest)?.variant;
      } catch {
        digestVariant = undefined;
      }
      if (digestVariant) {
        findings.push(ruleFinding('invalid-invoice-hash', `The invoice digest in the signature (ds:DigestValue ${digest}) is not the hash of the XML (${computed}).`, 'ds:SignedInfo/ds:Reference[@URI=""]/ds:DigestValue'));
        lint.push(finding('einv.hash-variant', `The signed invoice digest (ds:DigestValue) matches the hash computed the "${digestVariant}" way, not ZATCA's.`, { path: 'ds:SignedInfo/ds:Reference[@URI=""]/ds:DigestValue' }));
      } else {
        sigProblems.push(`the invoice digest (ds:DigestValue ${digest || 'empty'}) is not the hash of the XML (${computed}): the invoice was changed after signing`);
      }
    }

    if (!signatureValue) sigProblems.push('ds:SignatureValue is empty');
    else if (certPem && info) {
      let input: 'invoice-hash' | 'signed-info' | 'digest-value' | null = null;
      if (computed && ecdsaVerify(certPem, Buffer.from(computed, 'base64'), signatureValue)) input = 'invoice-hash';
      else if (signedInfo && ecdsaVerify(certPem, canonicalSignedInfo(signedInfo), signatureValue)) input = 'signed-info';
      else if (digest && digest !== computed && ecdsaVerify(certPem, Buffer.from(digest, 'base64'), signatureValue)) input = 'digest-value';
      if (input === 'invoice-hash') lint.push(finding('einv.signature-method', 'The ECDSA signature value is over the invoice hash bytes (as the ZATCA SDK signs).', { path: SIG_VALUE_PATH }));
      else if (input === 'signed-info') lint.push(finding('einv.signature-method', 'The ECDSA signature value is over the canonical ds:SignedInfo (XMLDSig), not over the invoice hash bytes; both are accepted.', { path: SIG_VALUE_PATH }));
      else if (input === null) sigProblems.push('ds:SignatureValue does not verify with the certificate public key (over the invoice hash bytes or the canonical ds:SignedInfo)');
      // 'digest-value': signed over the digest as written; the digest finding above covers it.
    }
    if (sigProblems.length) findings.push(ruleFinding('invalid-signature', `The invoice signature is invalid: ${sigProblems.join('; ')}.`, SIG_VALUE_PATH));

    // --- SignedProperties ---
    const sp = signedPropertiesFindings(ctx, refs);
    findings.push(...sp.findings);
    lint.push(...sp.lint);
    if (certPem && info) {
      const cd = certDigestFindings(sig, certPem, info);
      findings.push(...cd.findings);
      lint.push(...cd.lint);
    }
  }

  findings.push(...qrFindings(ctx, { computed, signatureValue: sig ? signatureValue : null, info, simplified }));
  return { findings, lint };
}

/** The phase 2 crypto module (findings only; validateInvoice runs cryptoChecks instead, to keep the lint). */
export const cryptoRules: RuleModule = (ctx) => cryptoChecks(ctx).findings;

function canonicalSignedInfo(signedInfo: Element): string {
  const alg = attr(children(signedInfo, 'ds:CanonicalizationMethod')[0] ?? signedInfo, 'Algorithm') ?? '';
  return canonicalize(signedInfo, { exclusive: alg.includes('exc-c14n') });
}

/** Issued by the instance CA, and the certificate of the CSID used for the request. */
function certFindings(ctx: RuleContext, certPem: string, info: CertInfo): RuleFinding[] {
  const out: RuleFinding[] = [];
  const path = 'ds:KeyInfo/ds:X509Data/ds:X509Certificate';
  const caPem = ctx.input.config.caCertPem;
  if (caPem && !certIssuedBy(certPem, caPem)) {
    out.push(ruleFinding('certificate-mismatch', `The signing certificate (issuer ${info.issuer.replace(/\n/g, ', ')}, serial ${info.serial}) was not issued by this instance's CA.`, path));
  }
  const csid = ctx.input.csid;
  if (csid?.certPem) {
    let same = false;
    try {
      same = certInfo(csid.certPem).serial === info.serial && toDer(csid.certPem).equals(toDer(certPem));
    } catch {
      same = false;
    }
    if (!same) out.push(ruleFinding('certificate-mismatch', `The signing certificate (serial ${info.serial}) is not the certificate of the ${csid.kind} CSID used for the request.`, path));
  }
  return out;
}

const toDer = (pem: string): Buffer => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');

/** The SignedProperties reference: present, pointing at xades:SignedProperties, digest of one of the accepted forms. */
function signedPropertiesFindings(ctx: RuleContext, refs: Element[]): CryptoResult {
  const findings: RuleFinding[] = [];
  const lint: EinvoiceLintFinding[] = [];
  const refPath = 'ds:SignedInfo/ds:Reference[@URI="#xadesSignedProperties"]';
  const ref =
    refs.find((r) => attr(r, 'Type') === SP_TYPE) ??
    refs.find((r) => attr(r, 'Type') === SP_TYPE_ALT) ??
    refs.find((r) => (attr(r, 'URI') ?? '').startsWith('#') && attr(r, 'URI') !== '') ??
    null;
  if (!ref) {
    findings.push(ruleFinding('signed-properties-hashing', "Invalid signed properties hashing, SignedProperties with id='xadesSignedProperties': ds:SignedInfo has no SignedProperties reference.", 'ds:SignedInfo'));
    return { findings, lint };
  }
  const type = attr(ref, 'Type');
  if (type === SP_TYPE_ALT) {
    lint.push(finding('einv.signature-variant', `The SignedProperties reference has Type ${SP_TYPE_ALT}; XAdES (and ZATCA) use ${SP_TYPE}.`, { path: refPath }));
  } else if (type !== SP_TYPE) {
    lint.push(finding('einv.signature-variant', `The SignedProperties reference has ${type ? `Type ${type}` : 'no Type'}; XAdES (and ZATCA) use ${SP_TYPE}.`, { path: refPath }));
  }
  const id = (attr(ref, 'URI') ?? '').replace(/^#/, '');
  const sp = descendants(ctx.doc, 'xades:SignedProperties').find((e) => attr(e, 'Id') === id) ?? null;
  if (!sp) {
    findings.push(ruleFinding('signed-properties-hashing', `Invalid signed properties hashing, SignedProperties with id='${id || 'xadesSignedProperties'}': there is no xades:SignedProperties with that Id.`, refPath));
    return { findings, lint };
  }
  const digest = strip(text(ref, 'ds:DigestValue'));
  const forms = signedPropertiesDigests(ctx.xml, sp);
  const hit = forms.find((f) => f.digest === digest);
  if (!hit) {
    findings.push(ruleFinding('signed-properties-hashing', `Invalid signed properties hashing, SignedProperties with id='${id}': the digest ${digest || '(empty)'} is not ${forms[0].digest}.`, `${refPath}/ds:DigestValue`));
  } else if (hit.form !== 'in place, hex') {
    lint.push(finding('einv.signature-variant', `The SignedProperties digest was computed ${hit.form}; ZATCA's is base64(hex(sha256)) of the inclusive C14N of the element in place.`, { path: `${refPath}/ds:DigestValue` }));
  }
  return { findings, lint };
}

/** The accepted SignedProperties digests; the first is ZATCA's (inclusive C14N in place, base64 of the hex digest). */
function signedPropertiesDigests(xml: string, sp: Element): { form: string; digest: string }[] {
  const inPlace = canonicalize(sp);
  const exclusive = canonicalize(sp, { exclusive: true });
  const out = [
    { form: 'in place, hex', digest: sha256hexb64(inPlace) },
    { form: 'in place with a raw (not hex) digest', digest: sha256b64(inPlace) },
    { form: 'over the exclusive C14N (without the ancestor namespaces), hex', digest: sha256hexb64(exclusive) },
    { form: 'over the exclusive C14N (without the ancestor namespaces), raw', digest: sha256b64(exclusive) },
  ];
  const tag = sp.tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const written = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`).exec(xml)?.[0];
  if (written) {
    out.push({ form: 'over its text as written (not canonicalized), hex', digest: sha256hexb64(written) });
    out.push({ form: 'over its text as written (not canonicalized), raw', digest: sha256b64(written) });
  }
  return out;
}

/** CertDigest (any certHashVariants form), X509SerialNumber (decimal) and X509IssuerName against the certificate. */
function certDigestFindings(sig: Element, certPem: string, info: CertInfo): CryptoResult {
  const findings: RuleFinding[] = [];
  const lint: EinvoiceLintFinding[] = [];
  const certEl = descendants(sig, 'xades:Cert')[0] ?? null;
  const base = 'xades:SignedProperties/xades:SignedSignatureProperties/xades:SigningCertificate/xades:Cert';
  if (!certEl) {
    findings.push(ruleFinding('certificate-mismatch', 'The SignedProperties have no xades:SigningCertificate/xades:Cert for the signing certificate.', 'xades:SignedProperties'));
    return { findings, lint };
  }
  const digest = strip(text(certEl, 'xades:CertDigest/ds:DigestValue'));
  const variants = certHashVariants(certPem);
  const NAMES: Record<keyof typeof variants, string> = {
    hex: 'base64(hex(sha256(DER)))',
    raw: 'base64(sha256(DER)), a raw digest instead of ZATCA\'s hex one',
    hexText: 'base64(hex(sha256)) of the PEM base64 text instead of the DER bytes',
    rawText: 'base64(sha256) of the PEM base64 text, raw, instead of the DER bytes',
  };
  const hit = (Object.keys(variants) as (keyof typeof variants)[]).find((k) => variants[k] === digest);
  if (!hit) {
    findings.push(ruleFinding('certificate-mismatch', `The CertDigest ${digest || '(empty)'} is not the digest of the signing certificate (${variants.hex}).`, `${base}/xades:CertDigest/ds:DigestValue`));
  } else if (hit !== 'hex') {
    lint.push(finding('einv.signature-variant', `The CertDigest was computed as ${NAMES[hit]}; ZATCA's is ${NAMES.hex}.`, { path: `${base}/xades:CertDigest/ds:DigestValue` }));
  }
  const serialText = (text(certEl, 'xades:IssuerSerial/ds:X509SerialNumber') ?? '').trim();
  const serial = decimalSerial(serialText);
  if (serial === null || serial !== BigInt(`0x${info.serial}`)) {
    findings.push(ruleFinding('certificate-mismatch', `The X509SerialNumber ${serialText || '(empty)'} is not the serial number of the signing certificate in decimal (${BigInt(`0x${info.serial}`).toString()}).`, `${base}/xades:IssuerSerial/ds:X509SerialNumber`));
  }
  const issuer = (text(certEl, 'xades:IssuerSerial/ds:X509IssuerName') ?? '').trim();
  if (!sameDn(issuer, info.issuer)) {
    findings.push(ruleFinding('certificate-mismatch', `The X509IssuerName "${issuer}" is not the issuer of the signing certificate (${info.issuer.split('\n').filter(Boolean).reverse().join(', ')}).`, `${base}/xades:IssuerSerial/ds:X509IssuerName`));
  }
  return { findings, lint };
}

interface QrCtx {
  computed: string | null;
  /** ds:SignatureValue (null without a signature: tag 7 is not checked). */
  signatureValue: string | null;
  /** The signing certificate (null: tags 8 and 9 are not checked). */
  info: CertInfo | null;
  simplified: boolean;
}

/** One QRCODE_INVALID per tag that is missing or does not match the invoice. */
function qrFindings(ctx: RuleContext, q: QrCtx): RuleFinding[] {
  const x = ctx.extracted;
  if (x.qr === null) return [];
  const bad = (msg: string) => ruleFinding('QRCODE_INVALID', msg, QR_PATH);
  const decoded = decodeTlv(x.qr);
  if (!decoded.ok) return [bad(`The QR code cannot be decoded: ${decoded.error}.`)];
  const tags = new Map<number, DecodedTlv>();
  for (const f of decoded.fields) if (!tags.has(f.tag)) tags.set(f.tag, f);

  const out: RuleFinding[] = [];
  const check = (tag: number, label: string, expected: string | null, same: (f: DecodedTlv, e: string) => boolean, show: (f: DecodedTlv) => string = (f) => f.text) => {
    if (expected === null) return;
    const f = tags.get(tag);
    if (!f) out.push(bad(`QR tag ${tag} (${label}) is missing.`));
    else if (!same(f, expected)) out.push(bad(`QR tag ${tag} (${label}) is ${show(f)}, expected ${expected}.`));
  };
  const textEq = (f: DecodedTlv, e: string) => f.text.trim() === e;
  const b64 = (f: DecodedTlv) => f.bytes.toString('base64');

  check(1, 'seller name', x.sellerName, textEq);
  check(2, 'seller VAT number', x.sellerVat, textEq);
  check(3, 'timestamp', x.issueDate && x.issueTime ? `${x.issueDate}T${x.issueTime}` : null, (f, e) => noZ(f.text) === noZ(e));
  check(4, 'total with VAT', trim(text(ctx.root, 'cac:LegalMonetaryTotal/cbc:TaxInclusiveAmount')), (f, e) => sameAmount(f.text, e));
  check(5, 'VAT total', trim(text(ctx.root, 'cac:TaxTotal/cbc:TaxAmount')), (f, e) => sameAmount(f.text, e));
  check(6, 'invoice hash', q.computed, (f, e) => asBase64(f) === e, asBase64);
  check(7, 'signature', q.signatureValue, (f, e) => asBase64(f) === e, asBase64);
  if (q.info) {
    check(8, 'public key', q.info.spkiDer.toString('base64'), (f, e) => asBase64(f) === e || b64(f) === e, b64);
    if (q.simplified) check(9, 'certificate signature', q.info.signatureValue.toString('base64'), (f, e) => b64(f) === e || asBase64(f) === e, b64);
  }
  return out;
}

const trim = (v: string | null): string | null => {
  const t = v?.trim();
  return t ? t : null;
};
