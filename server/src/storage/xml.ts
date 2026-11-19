/** Minimal XML for the S3 / Azure APIs: a builder and a small, non-validating parser (no dependency). */

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export type XmlChild = XmlNode | string | number | boolean | null | undefined | XmlChild[];
export interface XmlNode {
  name: string;
  attrs?: Record<string, string>;
  children: XmlChild[];
}

/** el('Key', 'a.txt'), el('Contents', [el('Key', k), …]); null / undefined children are skipped. */
export function el(name: string, ...children: XmlChild[]): XmlNode {
  return { name, children };
}

export function elA(name: string, attrs: Record<string, string>, ...children: XmlChild[]): XmlNode {
  return { name, attrs, children };
}

function render(c: XmlChild): string {
  if (c === null || c === undefined) return '';
  if (Array.isArray(c)) return c.map(render).join('');
  if (typeof c === 'object') {
    const attrs = c.attrs ? Object.entries(c.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : '';
    const inner = c.children.map(render).join('');
    return `<${c.name}${attrs}>${inner}</${c.name}>`;
  }
  return esc(String(c));
}

export function xmlDoc(root: XmlNode, ns?: string): string {
  const r = ns ? { ...root, attrs: { xmlns: ns, ...(root.attrs ?? {}) } } : root;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(r)}`;
}

// ---------------------------------------------------------------- parser

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

function unesc(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&';
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'quot') return '"';
    if (l === 'apos') return "'";
    return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  });
}

/** Parse a document; throws on malformed input. Namespace prefixes are dropped from names. */
export function parseXml(src: string): XmlElement {
  let i = 0;
  const root: XmlElement = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const local = (n: string) => n.replace(/^[^:]+:/, '');
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += unesc(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += unesc(src.slice(i, lt));
    if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt);
      if (e < 0) throw new Error('Unterminated processing instruction');
      i = e + 2;
    } else if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt);
      if (e < 0) throw new Error('Unterminated comment');
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      if (e < 0) throw new Error('Unterminated CDATA');
      stack[stack.length - 1].text += src.slice(lt + 9, e);
      i = e + 3;
    } else if (src.startsWith('<!', lt)) {
      const e = src.indexOf('>', lt);
      i = e < 0 ? src.length : e + 1;
    } else if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      if (e < 0) throw new Error('Unterminated end tag');
      const name = local(src.slice(lt + 2, e).trim());
      const top = stack.pop();
      if (!top || top.name !== name || stack.length === 0) throw new Error(`Unexpected </${name}>`);
      i = e + 1;
    } else {
      const e = src.indexOf('>', lt);
      if (e < 0) throw new Error('Unterminated start tag');
      let body = src.slice(lt + 1, e);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const m = /^([^\s/]+)\s*([\s\S]*)$/.exec(body.trim());
      if (!m) throw new Error('Invalid tag');
      const node: XmlElement = { name: local(m[1]), attrs: {}, children: [], text: '' };
      for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) node.attrs[local(a[1])] = unesc(a[3] ?? a[4] ?? '');
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
      i = e + 1;
    }
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1].name}>`);
  const top = root.children[0];
  if (!top) throw new Error('Empty document');
  return top;
}

export const child = (e: XmlElement | undefined, name: string): XmlElement | undefined => e?.children.find((c) => c.name === name);
export const children = (e: XmlElement | undefined, name: string): XmlElement[] => e?.children.filter((c) => c.name === name) ?? [];
export const text = (e: XmlElement | undefined, name: string): string | undefined => {
  const c = child(e, name);
  return c ? c.text : undefined;
};
