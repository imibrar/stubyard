// Copy text from an extension page: the async clipboard API, then execCommand('copy') (works in the widget iframe
// even where the page's Permissions-Policy blocks clipboard-write; docs/design/floating-widget.md, spike).
export async function copyText(text: string, doc: Document = document): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall back */
  }
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.append(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
