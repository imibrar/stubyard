import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element, Node } from '@xmldom/xmldom';

/** UBL 2.1 and signature namespaces used by ZATCA invoices. */
export const NS = {
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
  sig: 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
  sac: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
  sbc: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  xades: 'http://uri.etsi.org/01903/v1.3.2#',
} as const;

export type NsPrefix = keyof typeof NS;

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const CDATA_SECTION_NODE = 4;
export const PROCESSING_INSTRUCTION_NODE = 7;
export const COMMENT_NODE = 8;

/** The XML could not be parsed, or it uses a DOCTYPE / entity declarations (refused: XXE and entity expansion). */
export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlParseError';
  }
}

/** Parses an XML string. DOCTYPE and ENTITY declarations are refused before the parser sees them. */
export function parseXml(xml: string): Document {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new XmlParseError('DOCTYPE and entity declarations are not allowed');
  let doc: Document;
  try {
    doc = new DOMParser({
      onError: (level, msg) => {
        if (level !== 'warning') throw new XmlParseError(msg);
      },
    }).parseFromString(xml, 'text/xml');
  } catch (e) {
    throw e instanceof XmlParseError ? e : new XmlParseError(e instanceof Error ? e.message : String(e));
  }
  if (!doc.documentElement) throw new XmlParseError('no root element');
  if (doc.doctype) throw new XmlParseError('DOCTYPE and entity declarations are not allowed');
  return doc;
}

export function isElement(n: Node | null | undefined): n is Element {
  return !!n && n.nodeType === ELEMENT_NODE;
}

function resolve(step: string): [string, string] {
  const i = step.indexOf(':');
  if (i < 0) throw new Error(`path step needs a prefix: ${step}`);
  const ns = NS[step.slice(0, i) as NsPrefix];
  if (!ns) throw new Error(`unknown prefix in path step: ${step}`);
  return [ns, step.slice(i + 1)];
}

/** Child elements, optionally filtered by a prefixed name such as `cac:InvoiceLine`. */
export function children(el: Element, name?: string): Element[] {
  const want = name ? resolve(name) : null;
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (!isElement(n)) continue;
    if (!want || (n.namespaceURI === want[0] && n.localName === want[1])) out.push(n);
  }
  return out;
}

/**
 * First element (document order) matching a child path such as `cac:LegalMonetaryTotal/cbc:PayableAmount`.
 * All branches are tried, so a first `cac:TaxTotal` without the next step doesn't hide a later one.
 */
export function find(el: Element, path: string): Element | null {
  const steps = path.split('/').filter(Boolean);
  const walk = (cur: Element, i: number): Element | null => {
    if (i === steps.length) return cur;
    for (const c of children(cur, steps[i])) {
      const hit = walk(c, i + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(el, 0);
}

/** All elements matching a child path. */
export function findAll(el: Element, path: string): Element[] {
  let cur = [el];
  for (const step of path.split('/').filter(Boolean)) cur = cur.flatMap((c) => children(c, step));
  return cur;
}

/** Text content of the first element matching the path, or null when there is none. */
export function text(el: Element, path: string): string | null {
  const hit = find(el, path);
  return hit ? (hit.textContent ?? '') : null;
}

/** Attribute value, or null when absent. `ns` is a namespace URI for namespaced attributes. */
export function attr(el: Element, name: string, ns?: string): string | null {
  if (ns) return el.hasAttributeNS(ns, name) ? el.getAttributeNS(ns, name) : null;
  return el.hasAttribute(name) ? el.getAttribute(name) : null;
}

/** Every descendant element with the given prefixed name. */
export function descendants(root: Document | Element, name: string): Element[] {
  const [ns, local] = resolve(name);
  return Array.from(root.getElementsByTagNameNS(ns, local));
}
