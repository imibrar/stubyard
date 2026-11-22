import { esc } from '../../auth/pages.js';
import { BANNER_CSS, KIT_CSS } from './theme.js';
import { dirOf, t, TEST_NOTICE, type Locale } from './i18n.js';

/**
 * The checkout kit document shell: the mandatory test notice, the "[TEST]" title, lang / dir, the favicon and the
 * inline scripts (each its own <script> block, so pageCsp can hash them). Every stubyard payment page goes through
 * testTitle() + bannerHtml(), classic pages included (pages.ts page()).
 */

/** Inline icon (the dashboard's favicon.svg) so hosted pages never request /favicon.ico (img-src allows data:). */
export const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#4f46e5"/><path d="M9 11h14v10H9z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M9 11l7 6 7-6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>';
export const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

/** Embedded pages (HyperPay widget iframe) tell the parent their height so it can size the frame. */
export const EMBED_SCRIPT = "(function(){function h(){try{parent.postMessage({source:'stubyard-hyperpay',height:document.documentElement.scrollHeight},'*')}catch(e){}}window.addEventListener('load',h);window.addEventListener('resize',h);new MutationObserver(h).observe(document.body,{subtree:true,childList:true,attributes:true});h()})();";

export const TEST_PREFIX = '[TEST] ';

/** Every payment page title starts with "[TEST] ". */
export function testTitle(title: string): string {
  return title.startsWith(TEST_PREFIX) ? title : TEST_PREFIX + title;
}

export interface BannerOpts {
  locale?: Locale;
  /** full: the first screen; strip: a thin one-line strip (later screens, frames). Never hidden. */
  variant?: 'full' | 'strip';
  /** The stubyard host serving the page (a page on an unexpected host stands out). */
  host?: string | null;
  /** Show the "Test controls" button (kit pages with a drawer). */
  drawer?: boolean;
  /** POST target of the hidden-notice report (lint pay.test-notice-hidden). */
  notice?: string | null;
}

/** The test notice. English always; Arabic as well when the page is Arabic. */
export function bannerHtml(o: BannerOpts = {}): string {
  const locale = o.locale ?? 'en';
  // The thin strip keeps to one line: only the page language. The first screen shows English (+ Arabic on Arabic pages).
  const en = `<span lang="en" dir="ltr">${esc(TEST_NOTICE.en)}</span>`;
  const ar = `<span class="sy-ar" lang="ar" dir="rtl">${esc(TEST_NOTICE.ar)}</span>`;
  const msg = o.variant === 'strip' ? (locale === 'ar' ? ar : en) : locale === 'ar' ? en + ar : en;
  return `<aside class="sy-test${o.variant === 'strip' ? ' sy-strip' : ''}" id="sy-test" role="note" aria-label="${esc(TEST_NOTICE[locale])}" data-testid="stubyard-test-banner"${o.notice ? ` data-notice="${esc(o.notice)}"` : ''}><span class="sy-msg">${msg}</span>${o.host ? `<span class="sy-host" data-host-template="${esc(t(locale, 'servedBy', { host: '%HOST%' }))}">${esc(t(locale, 'servedBy', { host: o.host }))}</span>` : ''}${o.drawer ? `<button type="button" class="sy-ctl" data-sy-drawer aria-controls="k-drawer" data-testid="stubyard-drawer-toggle">${esc(t(locale, 'testControls'))}</button>` : ''}</aside>`;
}

/**
 * Banner script: reports a hidden, cropped or off-page notice once (lint only, never blocks a payment: Fable review 2),
 * wires the banner's "Test controls" button to the drawer and closes the drawer on Escape.
 */
export const BANNER_SCRIPT = `(function(){var b=document.getElementById('sy-test');if(!b)return;var N=b.getAttribute('data-notice'),sent=false;
function why(){var s=getComputedStyle(b);if(s.display==='none'||s.visibility==='hidden'||parseFloat(s.opacity)<0.3)return'hidden';var r=b.getBoundingClientRect();if(r.width<40||r.height<12)return'cropped';var top=r.top+(window.scrollY||0),left=r.left+(window.scrollX||0);if(top+r.height<=0||left+r.width<=0)return'offscreen';if(window.innerHeight<24||window.innerWidth<120)return'frame-too-small';return null}
function check(){if(sent||!N)return;var w=why();if(!w)return;sent=true;try{fetch(N,{method:'POST',keepalive:true,headers:{'content-type':'application/x-www-form-urlencoded'},body:'reason='+encodeURIComponent(w)+'&framed='+(window.top!==window?'1':'0')})}catch(e){}}
setTimeout(check,1500);document.addEventListener('submit',check,true);
var hs=b.querySelector('.sy-host');if(hs&&location.host){var tp=hs.getAttribute('data-host-template');if(tp)hs.textContent=tp.replace('%HOST%',location.host)}
var d=document.getElementById('k-drawer'),c=b.querySelector('[data-sy-drawer]');
function sum(){return d&&d.querySelector('summary')}
if(c&&d)c.addEventListener('click',function(){d.open=!d.open;c.setAttribute('aria-expanded',d.open?'true':'false');if(d.open){var s=sum();if(s)s.focus()}});
if(d)document.addEventListener('keydown',function(e){if(e.key==='Escape'&&d.open){d.open=false;var s=sum();if(s)s.focus()}});
})();`;

export interface KitDocument {
  title: string;
  locale: Locale;
  body: string;
  scripts?: string[];
  banner?: BannerOpts;
  /** HyperPay widget iframe: body class "embed" (compact; the parent sizes the frame). */
  embed?: boolean;
  /** A frame inside a stubyard page (3DS ACS): compact layout, thin banner. */
  frame?: boolean;
}

export function kitDocument(d: KitDocument): string {
  const scripts = [BANNER_SCRIPT, ...(d.scripts ?? []), ...(d.embed ? [EMBED_SCRIPT] : [])].filter(Boolean);
  return `<!doctype html><html lang="${d.locale}" dir="${dirOf(d.locale)}" class="k${d.frame ? ' k-frame' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(testTitle(d.title))}</title>${FAVICON}<style>${KIT_CSS}${BANNER_CSS}</style></head><body${d.embed ? ' class="embed"' : ''}>${bannerHtml({ locale: d.locale, ...(d.banner ?? {}) })}${d.body}${scripts.map((s) => `<script>${s}</script>`).join('')}</body></html>`;
}
