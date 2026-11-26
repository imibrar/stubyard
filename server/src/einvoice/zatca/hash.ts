import { createHash } from 'node:crypto';
import type { Document, Element, Node } from '@xmldom/xmldom';
import { canonicalize } from './c14n.js';
import { ELEMENT_NODE, TEXT_NODE, children, descendants, parseXml } from './xml.js';

/**
 * The ZATCA invoice hash (Security standard §2.3.3, BR-KSA-26):
 *   1. drop ext:UBLExtensions, cac:Signature and cac:AdditionalDocumentReference[cbc:ID='QR'] (the element nodes only;
 *      the whitespace text around them stays, as with the XPath filter);
 *   2. canonicalize (C14N 1.1, which is C14N 1.0 for UBL);
 *   3. SHA-256, base64 of the binary digest.
 */

/** PIH of the first invoice in a chain. Note: base64 of the HEX text of sha256("0"), not of the 32 raw bytes. */
export const FIRST_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

export function sha256b64(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('base64');
}

/** base64 of the lowercase hex digest: the ZATCA quirk used by the first PIH, SignedProperties and CertDigest. */
export function sha256hexb64(data: string | Buffer): string {
  return Buffer.from(createHash('sha256').update(data).digest('hex'), 'utf8').toString('base64');
}

/** True when `v` is a wrong spelling of the first PIH: base64 of the raw sha256("0"), or the bare hex. */
export function isFirstPihVariant(v: string): boolean {
  const hex = createHash('sha256').update('0').digest('hex');
  return v === sha256b64('0') || v.toLowerCase() === hex;
}

interface Transforms {
  dropQr?: boolean;
  dropSignatureParts?: boolean;
}

function applyTransforms(doc: Document, t: Transforms = {}): void {
  const doomed: Element[] = [];
  if (t.dropSignatureParts !== false) doomed.push(...descendants(doc, 'ext:UBLExtensions'), ...descendants(doc, 'cac:Signature'));
  if (t.dropQr !== false) {
    for (const ref of descendants(doc, 'cac:AdditionalDocumentReference')) {
      if (children(ref, 'cbc:ID').some((id) => id.textContent === 'QR')) doomed.push(ref);
    }
  }
  // Nested matches (one inside another) are removed with their ancestor; removing a detached node is skipped.
  for (const el of doomed) if (el.parentNode && attached(el, doc)) el.parentNode.removeChild(el);
}

function attached(n: Node, doc: Document): boolean {
  for (let p: Node | null = n; p; p = p.parentNode) if (p === doc) return true;
  return false;
}

/** The canonical bytes the hash is taken over. */
export function hashInput(xml: string): string {
  const doc = parseXml(xml);
  applyTransforms(doc);
  return canonicalize(doc);
}

export function invoiceHash(xml: string): string {
  return sha256b64(hashInput(xml));
}

export type HashVariant = 'minified' | 'qr-kept' | 'no-transforms' | 'exclusive-c14n' | 'hex-digest';

/**
 * Hashes computed the common wrong ways, for diagnostics: when a client's hash matches one of these instead of
 * invoiceHash(), lint can name the mistake. Some may equal the real hash (e.g. 'minified' on an already minified doc).
 */
export function hashVariants(xml: string): { variant: HashVariant; hash: string }[] {
  const out: { variant: HashVariant; hash: string }[] = [];

  const minified = parseXml(xml);
  applyTransforms(minified);
  dropWhitespaceText(minified.documentElement!);
  out.push({ variant: 'minified', hash: sha256b64(canonicalize(minified)) });

  const qrKept = parseXml(xml);
  applyTransforms(qrKept, { dropQr: false });
  out.push({ variant: 'qr-kept', hash: sha256b64(canonicalize(qrKept)) });

  out.push({ variant: 'no-transforms', hash: sha256b64(canonicalize(parseXml(xml))) });

  const exc = parseXml(xml);
  applyTransforms(exc);
  out.push({ variant: 'exclusive-c14n', hash: sha256b64(canonicalize(exc, { exclusive: true })) });

  out.push({ variant: 'hex-digest', hash: sha256hexb64(hashInput(xml)) });
  return out;
}

function dropWhitespaceText(el: Element): void {
  for (let n = el.firstChild; n; ) {
    const next = n.nextSibling;
    if (n.nodeType === TEXT_NODE && /^\s*$/.test(n.nodeValue ?? '')) el.removeChild(n);
    else if (n.nodeType === ELEMENT_NODE) dropWhitespaceText(n as Element);
    n = next;
  }
}
