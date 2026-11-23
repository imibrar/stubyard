import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe markdown renderer (React elements only, no HTML is ever injected): headings, paragraphs with line
 * breaks, bullet / numbered / task lists, quotes, fenced code, rules, inline code, bold, italic, strike, links
 * (http, https, mailto only; open in a new tab) and images. Images resolve through `image` (e.g. "image:<id>" → a
 * hub URL); any other image source is shown as a link and never loaded. Headings render as h3–h6 so the page keeps
 * its single h1.
 */
export function Markdown({ text, image, className = '' }: { text: string; image?: (src: string, alt: string) => { url: string; title?: string; onOpen?: () => void } | null; className?: string }) {
  const blocks = parseBlocks(text.replace(/\r\n?/g, '\n'));
  return <div className={`md ${className}`}>{blocks.map((b, i) => renderBlock(b, i, image))}</div>;
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; lines: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'list'; ordered: boolean; start: number; items: { text: string; task: boolean | null }[] };

function parseBlocks(src: string): Block[] {
  const lines = src.split('\n');
  const out: Block[] = [];
  let i = 0;
  const isBlank = (l: string) => l.trim() === '';
  const listRe = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = /^\s{0,3}(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ kind: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ kind: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push({ kind: 'quote', lines: body });
      continue;
    }
    const li = listRe.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: { text: string; task: boolean | null }[] = [];
      while (i < lines.length) {
        const m = listRe.exec(lines[i]);
        if (m && /\d/.test(m[1]) === ordered) {
          const t = /^\[([ xX])\]\s+(.*)$/.exec(m[2]);
          items.push(t ? { text: t[2], task: t[1] !== ' ' } : { text: m[2], task: null });
          i++;
        } else if (!isBlank(lines[i]) && /^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      out.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(li[1], 10) || 1 : 1, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !listRe.test(lines[i]) && !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i])) body.push(lines[i++]);
    if (!body.length) body.push(lines[i++]);
    out.push({ kind: 'p', lines: body });
  }
  return out;
}

type ImageFn = Parameters<typeof Markdown>[0]['image'];

function renderBlock(b: Block, key: number, image: ImageFn): ReactNode {
  switch (b.kind) {
    case 'h': {
      const Tag = (['h3', 'h3', 'h4', 'h5', 'h6', 'h6'] as const)[b.level - 1];
      return <Tag key={key}>{inline(b.text, image)}</Tag>;
    }
    case 'p':
      return <p key={key}>{lines(b.lines, image)}</p>;
    case 'code':
      return (
        <pre key={key} className="md-code" tabIndex={0}>
          <code>{b.text}</code>
        </pre>
      );
    case 'quote':
      return <blockquote key={key}>{lines(b.lines, image)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const items = b.items.map((it, j) => (
        <li key={j} className={it.task === null ? undefined : 'md-task'}>
          {it.task !== null && <input type="checkbox" checked={it.task} disabled aria-label={it.task ? 'Done' : 'Not done'} />}
          <span>{lines(it.text.split('\n'), image)}</span>
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
  }
}

function lines(ls: string[], image: ImageFn): ReactNode {
  return ls.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(l, image)}
    </Fragment>
  ));
}

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline spans: `code`, ![img](src), [link](url), **bold**, *italic* / _italic_, ~~strike~~, bare https:// links. */
export function inline(text: string, image?: ImageFn): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([^`]+?)\1|!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const key = k++;
    if (m[2] !== undefined) out.push(<code key={key}>{m[2]}</code>);
    else if (m[4] !== undefined) {
      const alt = m[3];
      const hit = image?.(m[4], alt);
      if (hit)
        out.push(
          hit.onOpen ? (
            <button key={key} type="button" className="md-img-btn" onClick={hit.onOpen} title={hit.title ?? `Open ${alt || 'image'}`}>
              <img src={hit.url} alt={alt} loading="lazy" />
            </button>
          ) : (
            <img key={key} src={hit.url} alt={alt} loading="lazy" />
          ),
        );
      else if (m[4].startsWith('image:')) out.push(<span key={key} className="md-missing">[missing image{alt ? `: ${alt}` : ''}]</span>);
      else if (SAFE_URL.test(m[4]))
        out.push(
          <a key={key} href={m[4]} target="_blank" rel="noopener noreferrer nofollow">
            {alt || m[4]} (image)
          </a>,
        );
      else out.push(m[0]);
    } else if (m[6] !== undefined) {
      if (SAFE_URL.test(m[6]))
        out.push(
          <a key={key} href={m[6]} target="_blank" rel="noopener noreferrer nofollow">
            {inline(m[5], image)}
          </a>,
        );
      else out.push(<Fragment key={key}>{inline(m[5], image)}</Fragment>);
    } else if (m[7] !== undefined || m[8] !== undefined) out.push(<strong key={key}>{inline(m[7] ?? m[8], image)}</strong>);
    else if (m[9] !== undefined) out.push(<del key={key}>{inline(m[9], image)}</del>);
    else if (m[10] !== undefined || m[11] !== undefined) out.push(<em key={key}>{inline(m[10] ?? m[11], image)}</em>);
    else if (m[12] !== undefined)
      out.push(
        <a key={key} href={m[12]} target="_blank" rel="noopener noreferrer nofollow">
          {m[12]}
        </a>,
      );
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
