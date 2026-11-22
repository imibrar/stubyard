import type { GatewayCtx } from '../gateway.js';
import { finding } from '../lint.js';
import { HttpError } from '../../util.js';

/**
 * The shared fake-SDK runtime (Payments P2): what every stubyard SDK (Moyasar Form, GeideaCheckout, the PayPal JS SDK)
 * needs on both sides of the frame boundary.
 *
 * Server side
 * - Which origins may use the SDK frames: the instance's sdkOrigins (config), the project's appOrigins and stubyard's
 *   own origin (its demo pages). With no list at all every origin is accepted and pay.sdk-origin-unlisted is recorded;
 *   with a list, another origin gets an error frame (pay.sdk-origin-refused) that posts nothing.
 * - The channel id a page gives its frames (random, per mount).
 *
 * Browser side (strings embedded in the SDK scripts and frame pages)
 * - SDK_RUNTIME (the merchant page): base discovery from the script URL, the TEST badge inside SDK-owned containers,
 *   iframe / overlay mounting and the message bridge to the frames. It only accepts messages whose event.origin is the
 *   stubyard origin the script came from, whose channel matches and (when known) whose source is the frame.
 * - frameBridge() (inside a stubyard frame): posts to exactly the merchant origin validated by the server (never '*',
 *   never document.referrer) and only listens to that origin's parent window.
 * Card digits never cross the bridge: frames post brand, last 4, the magic id and the Luhn / test flags only.
 */

export const CHANNEL_RE = /^[A-Za-z0-9_-]{6,40}$/;
export const channelOf = (v: unknown): string | null => (typeof v === 'string' && CHANNEL_RE.test(v) ? v : null);

/** An exact origin (scheme://host[:port]) or null. */
export function originOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > 300) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin === v.replace(/\/$/, '') ? u.origin : null;
  } catch {
    return null;
  }
}

/** Instance config sdkOrigins: an array or a comma / space separated string of origins (400 on a bad one); "" or [] clears it. */
export function normalizeSdkOrigins(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    const o = originOf(s);
    if (!o) throw new HttpError(400, `sdkOrigins: "${s.slice(0, 80)}" must be an origin like http://localhost:3000`);
    if (!out.includes(o)) out.push(o);
  }
  if (out.length > 50) throw new HttpError(400, 'sdkOrigins: at most 50 origins');
  return out;
}

/** The merchant origins allowed to use this instance's SDK frames (empty: any, with a lint finding). */
export function allowedSdkOrigins(c: GatewayCtx): string[] {
  let own: string[] = [];
  try {
    own = normalizeSdkOrigins(c.inst.config.sdkOrigins);
  } catch {
    own = [];
  }
  const app = (c.project.settings?.appOrigins ?? []).map((o) => originOf(o)).filter((o): o is string => !!o);
  return [...new Set([...own, ...app])];
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
}

/** stubyard's own origins for this request (the configured browser URL and the host the request came to). */
export function stubyardOrigins(c: GatewayCtx): string[] {
  const out = new Set<string>();
  for (const u of [c.base, requestBase(c)]) {
    const o = originOf(safeOrigin(u));
    if (o) out.add(o);
  }
  return [...out];
}

export type OriginCheck = { ok: true; origin: string; listed: boolean } | { ok: false; origin: string | null; reason: 'missing' | 'refused' };

/**
 * Whether a frame may serve the merchant page at `raw` (the frame URL's origin= parameter, set by the SDK from
 * location.origin). Records the lint finding on the payment (onPayment) or else on the instance.
 */
export function checkSdkOrigin(c: GatewayCtx, raw: unknown, what: string, onPayment?: (f: ReturnType<typeof finding>) => void): OriginCheck {
  const origin = originOf(raw);
  if (!origin) return { ok: false, origin: null, reason: 'missing' };
  if (stubyardOrigins(c).includes(origin)) return { ok: true, origin, listed: true };
  const allowed = allowedSdkOrigins(c);
  const record = (f: ReturnType<typeof finding>) => {
    if (onPayment) onPayment(f);
    else c.svc.addInstanceLint(c.inst, f);
    c.svc.changed(c.project.id, { instance: c.inst.slug });
  };
  if (!allowed.length) {
    record(finding('pay.sdk-origin-unlisted', `${what} ran on ${origin}, which is not in the instance's sdkOrigins or the project's appOrigins (allowed because neither list is set)`));
    return { ok: true, origin, listed: false };
  }
  if (allowed.includes(origin)) return { ok: true, origin, listed: true };
  record(finding('pay.sdk-origin-refused', `${what} was opened from ${origin}, which is not allowed (allowed: ${allowed.join(', ')})`));
  return { ok: false, origin, reason: 'refused' };
}

/** Instance base on the request's own origin (proto from X-Forwarded-Proto, else the socket); STUBYARD_PUBLIC_URL wins. */
export function requestBase(c: GatewayCtx): string {
  if (c.hub.config.publicUrl) return c.base;
  const host = String(c.req.headers.host ?? '');
  const fwd = String(c.req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase();
  const proto = fwd === 'http' || fwd === 'https' ? fwd : c.req.protocol;
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host)) return c.base;
  return `${proto}://${host}${c.svc.instancePath(c.project, c.inst)}`;
}

/** CORS for SDK JSON endpoints: the calling page's origin when it may use the SDK, else none (the browser blocks). */
export function sdkCors(c: GatewayCtx): string | null {
  const o = originOf(c.req.headers.origin);
  c.reply.header('vary', 'Origin').header('cross-origin-resource-policy', 'cross-origin');
  if (!o) return null;
  const allowed = allowedSdkOrigins(c);
  if (allowed.length && !allowed.includes(o) && !stubyardOrigins(c).includes(o)) return null;
  c.reply.header('access-control-allow-origin', o).header('access-control-allow-headers', 'content-type').header('access-control-allow-methods', 'GET, POST, OPTIONS');
  return o;
}

const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');
const ESC = (h: string) => '\\' + 'u' + h;
/** JSON for an inline script (no "</script>" break-out, no raw line separators). */
export const js = (v: unknown) => JSON.stringify(v).replace(/</g, ESC('003c')).replace(LS, ESC('2028')).replace(PS, ESC('2029'));

/**
 * Inside a stubyard frame: SYB.post(msg) to the merchant origin only; SYB.on(fn) for the parent's messages (from
 * that origin and that window only); the frame reports its height as {type:'resize'}. Target: the opener for popups,
 * else the parent.
 */
export function frameBridge(o: { origin: string; ch: string; source: string; resize?: boolean }): string {
  const resize = o.resize === false ? '' : "var lh=0;function rs(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==lh){lh=h;post({type:'resize',height:h})}}window.addEventListener('load',rs);window.addEventListener('resize',rs);try{new MutationObserver(rs).observe(document.body,{subtree:true,childList:true,attributes:true})}catch(e){}setTimeout(rs,0);";
  return `var SYB=(function(O,CH,SRC){var T=window.opener||(window.parent!==window?window.parent:null);var hs=[];
function post(m){if(!T)return;m=m||{};m.source=SRC;m.ch=CH;try{T.postMessage(m,O)}catch(e){}}
window.addEventListener('message',function(e){if(e.origin!==O||e.source!==T)return;var d=e.data;if(!d||d.source!==SRC+'-host'||d.ch!==CH)return;for(var i=0;i<hs.length;i++){try{hs[i](d)}catch(x){}}});
${resize}return{post:post,on:function(h){hs.push(h)}}})(${js(o.origin)},${js(o.ch)},${js(o.source)});`;
}

/**
 * The merchant-page half (embedded in each SDK script). Defines SY with:
 * base(re, fallback), uid(), lang(opt), el(selectorOrNode), badge(host, lang), frame(src, title, height),
 * overlay({src, title, lang, sheet}), bridge({origin, ch, source, win}) → {on, send, close}, originOf(url).
 * Styles go through element.style (CSSOM), so a merchant CSP without 'unsafe-inline' does not block them.
 */
export const SDK_RUNTIME = `var SY=(function(){
var TEST={en:'TEST · stubyard simulator · not a real payment, no money moves',ar:'تجربة · محاكي stubyard · ليست عملية دفع حقيقية، ولا تُنقل أي أموال'};
function base(re,fb){try{var s=document.currentScript&&document.currentScript.src;if(s){var u=new URL(s);return u.origin+u.pathname.replace(re,'')}}catch(e){}return fb}
function uid(){try{var a=new Uint8Array(12);crypto.getRandomValues(a);return'ch'+Array.prototype.map.call(a,function(b){return('0'+b.toString(16)).slice(-2)}).join('')}catch(e){return'ch'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}}
function lang(o){var l=String(o||document.documentElement.lang||'en').toLowerCase();return l.indexOf('ar')===0?'ar':'en'}
function el(s){return typeof s==='string'?document.querySelector(s):s}
function badge(host,l){var b=document.createElement('div');b.setAttribute('data-testid','stubyard-sdk-badge');b.setAttribute('role','note');b.setAttribute('lang',l);b.dir=l==='ar'?'rtl':'ltr';b.textContent=TEST[l]||TEST.en;
b.style.cssText='display:block;box-sizing:border-box;margin:0 0 8px;padding:6px 10px;border-radius:6px;background:#fff7e0;color:#3d2a00;border:1px solid #1a1a1a;border-inline-start:6px solid #f5b400;font:600 12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:start;overflow-wrap:anywhere';
host.insertBefore(b,host.firstChild);return b}
function frame(src,title,h){var f=document.createElement('iframe');f.src=src;f.title=title;f.style.cssText='display:block;width:100%;min-width:0;height:'+(h||320)+'px;border:0;background:transparent';return f}
function overlay(o){var narrow=(window.innerWidth||1024)<480;var w=document.createElement('div');w.setAttribute('data-testid','stubyard-sdk-overlay');w.setAttribute('role','dialog');w.setAttribute('aria-modal','true');w.setAttribute('aria-label',o.title);
w.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(15,17,21,.6);display:flex;align-items:'+(o.sheet?'flex-end':'center')+';justify-content:center;padding:'+(o.sheet||narrow?'0':'12px')+';box-sizing:border-box';
var box=document.createElement('div');box.style.cssText='position:relative;width:100%;max-width:'+(o.sheet?'440px':'520px')+';height:'+(o.sheet?'auto':'100%')+';max-height:'+(o.sheet?'92vh':narrow?'none':'760px')+';background:#fff;border-radius:'+(o.sheet?'14px 14px 0 0':narrow?'0':'12px')+';overflow:hidden;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.35)';
var bar=document.createElement('div');bar.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 6px 12px;background:#f2f4f7;border-bottom:1px solid #d6dae1;font:600 13px/1.3 system-ui,sans-serif;color:#15171c';bar.dir=o.lang==='ar'?'rtl':'ltr';
var t=document.createElement('span');t.textContent=o.title;var x=document.createElement('button');x.type='button';x.textContent=o.lang==='ar'?'إغلاق':'Close';x.setAttribute('data-testid','stubyard-sdk-close');
x.style.cssText='min-height:40px;min-width:64px;border:1px solid #b9bfca;border-radius:6px;background:#fff;color:#15171c;cursor:pointer;font:600 14px system-ui,sans-serif';
bar.appendChild(t);bar.appendChild(x);var f=frame(o.src,o.title,o.sheet?440:0);f.style.height=o.sheet?'440px':'100%';f.style.flex='1 1 auto';box.appendChild(bar);box.appendChild(f);w.appendChild(box);document.body.appendChild(w);
var prev=document.activeElement;try{x.focus()}catch(e){}
function close(){if(w.parentNode)w.parentNode.removeChild(w);try{if(prev&&prev.focus)prev.focus()}catch(e){}}
w.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();x.click()}});
return{el:w,frame:f,closeBtn:x,close:close}}
function bridge(o){var hs=[];function on(e){if(e.origin!==o.origin)return;var w=o.win&&o.win();if(w&&e.source!==w)return;var d=e.data;if(!d||d.source!==o.source||d.ch!==o.ch)return;for(var i=0;i<hs.length;i++){try{hs[i](d)}catch(x){if(window.console)console.error(x)}}}
window.addEventListener('message',on);
return{on:function(h){hs.push(h)},send:function(m){var w=o.win&&o.win();if(!w)return;m=m||{};m.source=o.source+'-host';m.ch=o.ch;try{w.postMessage(m,o.origin)}catch(e){}},close:function(){window.removeEventListener('message',on)}}}
function originOf(b){try{return new URL(b).origin}catch(e){return''}}
return{base:base,uid:uid,lang:lang,el:el,badge:badge,frame:frame,overlay:overlay,bridge:bridge,originOf:originOf,TEST:TEST}})();`;
