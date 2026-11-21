// Content script entry (built as one IIFE: content.js). Injected on demand by the side panel; idempotent.
// It only does DOM work and answers panel messages: it never calls stubyard and never renders templates.
import { CONTENT_VERSION, type ContentRequest, type ContentResponseMap } from '../shared/protocol';
import { assertPage, capture, highlight, probe, setValue } from './capture';
import { fillForm } from './fill';
import { scanPage } from './scan';

export async function handleRequest(req: ContentRequest): Promise<ContentResponseMap[ContentRequest['type']]> {
  switch (req.type) {
    case 'ping': return { ok: true, version: CONTENT_VERSION, url: location.href };
    case 'scan': return scanPage({ includeHidden: req.includeHidden });
    case 'fill': return fillForm(req.entries, { formId: req.formId, overwrite: req.overwrite });
    case 'probe': return probe(req.selector);
    case 'setValue': return setValue(req.selector, req.value);
    case 'capture': return capture(req);
    case 'assert': return assertPage(req);
    case 'highlight': return highlight(req);
  }
}

const TYPES: ReadonlySet<string> = new Set<ContentRequest['type']>(['ping', 'scan', 'fill', 'probe', 'setValue', 'capture', 'assert', 'highlight']);

declare global {
  interface Window { __stubyardContent?: string }
}

if (!window.__stubyardContent && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  window.__stubyardContent = CONTENT_VERSION;
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !TYPES.has((msg as { type?: string }).type ?? '')) return false;
    handleRequest(msg as ContentRequest).then(sendResponse, (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  });
}
