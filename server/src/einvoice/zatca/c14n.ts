import type { Attr, Document, Element, Node } from '@xmldom/xmldom';
import { CDATA_SECTION_NODE, COMMENT_NODE, ELEMENT_NODE, PROCESSING_INSTRUCTION_NODE, TEXT_NODE } from './xml.js';

/**
 * Canonical XML without comments.
 *
 * Inclusive mode is C14N 1.0 (http://www.w3.org/TR/2001/REC-xml-c14n-20010315). C14N 1.1, which ZATCA names, differs
 * only in how xml:id / xml:base are inherited into a document subset; UBL invoices use neither, so the output is the
 * same. Exclusive mode (http://www.w3.org/2001/10/xml-exc-c14n#, no InclusiveNamespaces list) is here only to
 * recognise clients that hash with the wrong algorithm.
 *
 * Input is a whole document, or an element treated as the apex of a subtree (its ancestors' namespaces are in scope;
 * inherited xml:* attributes are not copied down). Line endings are already normalised by the parser.
 */

const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export interface C14nOptions {
  exclusive?: boolean;
}

type NsMap = Map<string, string>;

export function canonicalize(node: Document | Element, opts: C14nOptions = {}): string {
  const out: string[] = [];
  const exclusive = !!opts.exclusive;
  if (node.nodeType === ELEMENT_NODE) {
    renderElement(node as Element, ancestorScope(node as Element), new Map([['', '']]), exclusive, out);
    return out.join('');
  }
  // Document: PIs before the root element are followed by #xA, those after it are preceded by #xA.
  let seenRoot = false;
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE) {
      renderElement(n as Element, new Map([['', '']]), new Map([['', '']]), exclusive, out);
      seenRoot = true;
    } else if (n.nodeType === PROCESSING_INSTRUCTION_NODE && (n as Node & { target: string }).target !== 'xml') {
      // xmldom keeps the XML declaration as a PI with target "xml"; the canonical form has no declaration.
      if (seenRoot) out.push('\n');
      out.push(renderPi(n));
      if (!seenRoot) out.push('\n');
    }
  }
  return out.join('');
}

/** Namespaces declared on the element's ancestors (nearest wins). */
function ancestorScope(el: Element): NsMap {
  const chain: Element[] = [];
  for (let p = el.parentNode; p && p.nodeType === ELEMENT_NODE; p = p.parentNode) chain.unshift(p as Element);
  let scope: NsMap = new Map([['', '']]);
  for (const a of chain) scope = withDecls(scope, a);
  return scope;
}

function isNsDecl(a: Attr): boolean {
  return a.namespaceURI === XMLNS_NS || a.name === 'xmlns' || a.name.startsWith('xmlns:');
}

function declPrefix(a: Attr): string {
  return a.name === 'xmlns' ? '' : a.name.slice(6);
}

function withDecls(scope: NsMap, el: Element): NsMap {
  const next = new Map(scope);
  for (const a of Array.from(el.attributes)) if (isNsDecl(a)) next.set(declPrefix(a), a.value);
  return next;
}

/**
 * @param parentScope namespaces in scope on the parent
 * @param rendered    namespaces already rendered by output ancestors ('' maps to the default namespace)
 */
function renderElement(el: Element, parentScope: NsMap, rendered: NsMap, exclusive: boolean, out: string[]): void {
  const scope = withDecls(parentScope, el);
  const attrs = Array.from(el.attributes).filter((a) => !isNsDecl(a));

  // Namespace axis: inclusive renders every in-scope namespace, exclusive only the visibly utilised ones. Either way a
  // declaration is emitted only when it differs from what the nearest output ancestor rendered. xml: is never emitted.
  const candidates = new Set<string>();
  if (exclusive) {
    candidates.add(el.prefix ?? '');
    for (const a of attrs) if (a.prefix && a.prefix !== 'xml') candidates.add(a.prefix);
  } else {
    for (const p of scope.keys()) candidates.add(p);
  }
  const ns: [string, string][] = [];
  const nextRendered = new Map(rendered);
  for (const p of candidates) {
    if (p === 'xml') continue;
    const uri = scope.get(p) ?? '';
    if ((rendered.get(p) ?? (p === '' ? '' : undefined)) === uri) continue;
    if (p !== '' && uri === '') continue; // an undeclared prefix (XML 1.1 xmlns:p="") is not rendered
    ns.push([p, uri]);
    nextRendered.set(p, uri);
  }
  ns.sort((a, b) => cmp(a[0], b[0])); // default namespace ('') sorts first

  attrs.sort((a, b) => cmp(a.namespaceURI ?? '', b.namespaceURI ?? '') || cmp(a.localName ?? a.name, b.localName ?? b.name));

  out.push('<', el.tagName);
  for (const [p, uri] of ns) out.push(p ? ` xmlns:${p}="` : ' xmlns="', escapeAttr(uri), '"');
  for (const a of attrs) out.push(' ', a.name, '="', escapeAttr(a.value), '"');
  out.push('>');
  for (let n: Node | null = el.firstChild; n; n = n.nextSibling) {
    switch (n.nodeType) {
      case ELEMENT_NODE:
        renderElement(n as Element, scope, nextRendered, exclusive, out);
        break;
      case TEXT_NODE:
      case CDATA_SECTION_NODE:
        out.push(escapeText(n.nodeValue ?? ''));
        break;
      case PROCESSING_INSTRUCTION_NODE:
        out.push(renderPi(n));
        break;
      case COMMENT_NODE:
      default:
        break;
    }
  }
  out.push('</', el.tagName, '>');
}

function renderPi(n: Node): string {
  const pi = n as Node & { target: string; data: string };
  return pi.data ? `<?${pi.target} ${pi.data}?>` : `<?${pi.target}?>`;
}

/** Code-point order (UTF-16 order differs only for astral characters, which don't occur in names here). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}
