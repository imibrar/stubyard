/**
 * Data-set URL patterns (match.urlPattern), docs/design/storyboards.md §1.3. The extension has a copy
 * (packages/extension/src/shared/urlPattern.ts) with the same rules:
 *  - A glob on the URL path; the query is matched too only when the pattern has a "?" (in the given order).
 *  - "*" = any characters inside one path segment (no "/"); "**" = any characters, "/" included, and at a segment
 *    boundary also nothing at all ("/admin/**" matches "/admin").
 *  - The fragment is ignored, a trailing "/" is ignored on both sides, a pattern without a leading "/" gets one, and
 *    an origin in the pattern or the URL is ignored. Matching is case-sensitive. An empty pattern matches every URL.
 */

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function splitUrl(url: string): { path: string; query: string } {
  let rest = url;
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  const q = rest.indexOf('?');
  const path = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? rest.slice(q + 1) : '';
  return { path: trimSlash(path || '/'), query };
}

function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "/**" at a segment boundary may match nothing at all ("/admin/**" ~ "/admin").
        if (re.endsWith('\\/')) re = re.slice(0, -2) + '(?:\\/.*)?';
        else re += '.*';
        i++;
        if (glob[i + 1] === '/') {
          re += '\\/?';
          i++;
        }
      } else re += '[^/]*';
    } else re += c.replace(/[.+?^${}()|[\]\\/]/g, '\\$&');
  }
  return re;
}

/** Score of a match (higher = more specific: the count of literal characters), or null when the URL does not match. */
export function urlPatternScore(pattern: string | undefined | null, url: string): number | null {
  const p = (pattern ?? '').trim();
  if (!p) return 0;
  const target = splitUrl(url);
  const pat = splitUrl(p.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : '/' + p);
  if (!new RegExp('^' + globToRegex(pat.path) + '$').test(target.path)) return null;
  const hasQuery = p.includes('?');
  if (hasQuery && !new RegExp('^' + globToRegex(pat.query) + '$').test(target.query)) return null;
  return (pat.path + (hasQuery ? '?' + pat.query : '')).replace(/\*/g, '').length;
}

export function matchUrlPattern(pattern: string | undefined | null, url: string): boolean {
  return urlPatternScore(pattern, url) !== null;
}
