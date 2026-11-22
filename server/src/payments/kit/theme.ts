/**
 * Checkout kit styles: stubyard's own neutral design tokens (the dashboard palette, system font stack), logical
 * CSS properties so one stylesheet serves LTR and RTL, and breakpoints for 390 / 768 / 1280 / 1920 px.
 * No provider colours, fonts, logos or icons (plans-final B: neutral look, no pixel clones).
 */

/** The test notice: a hatched amber / black edge that no provider uses. Shared with the classic pages. */
export const BANNER_CSS = `
.sy-test{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:9px 14px;background:#fff7e0;color:#3d2a00;border-block-end:3px solid #1a1a1a;
background-image:linear-gradient(#fff7e0,#fff7e0),repeating-linear-gradient(135deg,#f5b400 0 10px,#1a1a1a 10px 20px);background-size:100% calc(100% - 6px),100% 6px;background-position:top,bottom;background-repeat:no-repeat;
font:600 13px/1.4 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Naskh Arabic',sans-serif;padding-block-end:15px;position:relative;z-index:30}
.sy-test .sy-tag{background:#1a1a1a;color:#ffd54a;border-radius:4px;padding:1px 7px;font-size:12px;letter-spacing:.06em}
.sy-test .sy-msg{flex:1 1 260px;min-width:0}.sy-test .sy-msg span{display:block}.sy-test .sy-ar{font-weight:600}
.sy-test .sy-host{font:500 11.5px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#6b4e00;overflow-wrap:anywhere}
.sy-test .sy-ctl{font:600 12.5px/1 inherit;font-family:inherit;background:#1a1a1a;color:#fff;border:0;border-radius:6px;padding:8px 12px;min-height:34px;cursor:pointer}
.sy-test .sy-ctl:focus-visible{outline:2px solid #f5b400;outline-offset:2px}
.sy-test.sy-strip{padding:4px 12px 9px;font-size:12px;gap:4px 10px;background-size:100% calc(100% - 4px),100% 4px}.sy-test.sy-strip .sy-msg{flex-basis:200px}
.sy-test.sy-strip .sy-msg span{display:inline}.sy-test.sy-strip .sy-msg span+span::before{content:' · '}
@media (prefers-color-scheme:dark){.sy-test{background-color:#2a2108;color:#ffe9a8;background-image:linear-gradient(#2a2108,#2a2108),repeating-linear-gradient(135deg,#f5b400 0 10px,#000 10px 20px)}.sy-test .sy-host{color:#e7c56a}.sy-test .sy-ctl{background:#ffd54a;color:#1a1a1a}}
@media print{.sy-test{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

export const KIT_CSS = `
:root{--bg:#f5f6f8;--panel:#fff;--panel-2:#f2f4f7;--panel-3:#e9ecf1;--border:#e2e5ea;--border-strong:#cfd4dc;--text:#15171c;--muted:#5d6471;--faint:#8f96a3;
--accent:#4f46e5;--accent-soft:#eef0ff;--accent-text:#3730a3;--ok:#15803d;--ok-soft:#e7f6ec;--warn:#b45309;--warn-soft:#fdf3e3;--bad:#b91c1c;--bad-soft:#fdeceb;
--radius:8px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Naskh Arabic',sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c10;--panel:#111318;--panel-2:#171a21;--panel-3:#1e222b;--border:#23272f;--border-strong:#323843;--text:#e7e9ee;--muted:#9ba2ae;--faint:#656c78;
--accent:#7c83ff;--accent-soft:rgba(124,131,255,.14);--accent-text:#b9bdff;--ok:#4ade80;--ok-soft:rgba(74,222,128,.12);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.12);--bad:#f87171;--bad-soft:rgba(248,113,113,.12);color-scheme:dark}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
a{color:var(--accent-text)}
.hide{display:none!important}
.k-wrap{max-width:1120px;margin:0 auto;padding:20px 16px 40px}
.k-quick{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;max-width:1120px;margin:10px auto 0;padding:0 16px;font-size:13px;color:var(--muted)}
.k-quick .k-qlabel{font-weight:600;margin-inline-end:4px}
.k-qbtn{background:var(--panel);border:1px dashed var(--border-strong);border-radius:6px;padding:6px 12px;min-height:36px;font-size:13px}
.k-qbtn:hover,.k-qbtn:focus-visible{border-color:var(--accent);outline:none}.k-qbtn.bad{color:var(--bad)}
.k-forced{border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);background:var(--accent-soft);color:var(--accent-text);border-radius:var(--radius);padding:8px 12px;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;flex:1 1 100%}
.k-forced b{font-weight:600}
/* fields */
.k-field{display:block;margin:0 0 14px}.k-field>.k-lbl{display:block;font-size:13.5px;color:var(--muted);margin-bottom:5px;font-weight:500}
.k-input,.k-select{width:100%;background:var(--panel);border:1px solid var(--border-strong);border-radius:6px;padding:10px 12px;min-height:44px;font-size:15px}
.k-input:focus,.k-select:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:0;border-color:var(--accent)}
.k-input[readonly]{background:var(--panel-2);color:var(--muted)}
.k-input.k-bad{border-color:var(--bad)}
.k-group{border:1px solid var(--border-strong);border-radius:6px;overflow:hidden;background:var(--panel)}
.k-group .k-input{border:0;border-radius:0;min-height:44px}.k-group .k-input:focus{outline:2px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:-2px}
.k-group .k-row{display:flex;border-block-start:1px solid var(--border-strong)}.k-group .k-row>*{flex:1 1 50%;min-width:0}.k-group .k-row>*+*{border-inline-start:1px solid var(--border-strong)}
.k-pan{position:relative}.k-pan .k-brand{position:absolute;inset-inline-end:10px;top:50%;transform:translateY(-50%);font:600 11px/1 var(--mono);text-transform:uppercase;color:var(--muted);background:var(--panel-2);border:1px solid var(--border);border-radius:4px;padding:4px 6px;pointer-events:none}
.k-pan .k-input{padding-inline-end:96px}
.k-pan .k-input,#exp,#cvc,#pan,.k-otp,.k-num{direction:ltr;text-align:start}[dir=rtl] .k-pan .k-input,[dir=rtl] #exp,[dir=rtl] #cvc{text-align:right}
.k-err{color:var(--bad);font-size:13.5px;margin:6px 0 0}.k-alert{border-radius:var(--radius);padding:10px 12px;font-size:14px;background:var(--bad-soft);color:var(--bad);margin:0 0 14px}
.k-hint{font-size:12.5px;color:var(--faint);margin:4px 0 0}
.k-methods{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:0 0 14px}
.k-method{display:flex;align-items:center;gap:8px;border:1px solid var(--border-strong);border-radius:6px;padding:10px 12px;min-height:48px;background:var(--panel);cursor:pointer;font-weight:500}
.k-method input{margin:0;accent-color:var(--accent)}.k-method:has(input:checked){border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);background:var(--accent-soft)}
.k-method:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.k-paybtn{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:600;font-size:16px;padding:12px 16px}
.k-paybtn:hover{filter:brightness(1.06)}.k-paybtn:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
.k-paybtn[disabled]{opacity:.85;cursor:progress}.k-spin{display:none;width:18px;height:18px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:k-spin .7s linear infinite}
.k-busy .k-spin{display:inline-block}.k-busy .k-label{opacity:.9}
@keyframes k-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.k-spin{animation-duration:2s}}
.k-wallet{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:48px;border-radius:6px;border:1px solid var(--text);background:var(--text);color:var(--panel);font-weight:600}
.k-or{display:flex;align-items:center;gap:10px;color:var(--faint);font-size:13px;margin:16px 0}.k-or::before,.k-or::after{content:'';flex:1;height:1px;background:var(--border)}
.k-foot{display:flex;flex-wrap:wrap;gap:4px 14px;justify-content:center;color:var(--faint);font-size:12.5px;margin-top:18px;text-align:center}
.k-foot span{white-space:nowrap}
/* generic single card */
.k-card{max-width:560px;margin:0 auto;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.k-head{padding:18px 20px;border-block-end:1px solid var(--border);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.k-mono{width:40px;height:40px;border-radius:9px;background:var(--accent-soft);color:var(--accent-text);display:grid;place-items:center;font-weight:700;flex:none}
.k-head h1{font-size:17px;margin:0;line-height:1.3;flex:1;min-width:0}.k-head h1 small{display:block;font-size:12.5px;color:var(--muted);font-weight:400}
.k-amt{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.k-sec{padding:16px 20px;border-block-end:1px solid var(--border)}.k-sec:last-child{border-block-end:0}
.k-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;margin:0}.k-meta dt{color:var(--muted)}.k-meta dd{margin:0;font-family:var(--mono);word-break:break-all}
/* stripe-style two-column checkout */
.k-split{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;max-width:1040px;margin:0 auto;padding:16px 16px 40px}
.k-summary{padding:8px 4px}.k-pane{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px}
.k-merchant{display:flex;align-items:center;gap:10px;font-weight:600;flex-wrap:wrap}
.k-back{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;border:1px solid var(--border-strong);background:var(--panel);padding:0}
.k-back:hover,.k-back:focus-visible{border-color:var(--accent);outline:none}[dir=rtl] .k-back svg{transform:scaleX(-1)}
.k-mlogo{width:28px;height:28px;border-radius:6px;background:var(--panel-3);display:grid;place-items:center;font-size:13px;font-weight:700;color:var(--muted)}
.k-pill{font:600 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.05em;background:var(--warn-soft);color:var(--warn);border-radius:4px;padding:4px 6px}
.k-paylabel{color:var(--muted);margin:22px 0 2px;font-weight:500}.k-bigamt{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.15;margin:0 0 18px}
.k-items{list-style:none;margin:0;padding:0}.k-items li{display:flex;gap:12px;justify-content:space-between;padding:10px 0;border-block-end:1px solid var(--border)}
.k-items .k-iname{font-weight:500}.k-items .k-isub{font-size:13px;color:var(--muted)}.k-items .k-iamt{font-variant-numeric:tabular-nums;white-space:nowrap}
.k-tot{display:flex;justify-content:space-between;padding:10px 0;font-variant-numeric:tabular-nums}.k-tot.k-total{font-weight:600;border-block-start:1px solid var(--border)}
.k-pane h2{font-size:17px;margin:0 0 14px}
@media (min-width:900px){.k-split{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:56px;padding-top:40px}.k-summary{padding-top:16px}.k-pane{padding:28px}}
@media (min-width:1600px){.k-split{max-width:1180px}}
@media (max-width:480px){.k-wrap{padding:12px 10px 32px}.k-split{padding:10px 10px 32px;gap:12px}.k-pane{padding:16px}.k-bigamt{font-size:28px}.k-head,.k-sec{padding:14px}.k-amt{font-size:19px}}
/* drawer */
.k-drawer{position:fixed;inset-block:0;inset-inline-end:0;z-index:40;pointer-events:none}
.k-drawer>summary{list-style:none;position:fixed;inset-inline-end:16px;inset-block-end:16px;pointer-events:auto;background:#1a1a1a;color:#fff;border-radius:999px;padding:10px 16px;min-height:44px;display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.k-drawer>summary::-webkit-details-marker{display:none}.k-drawer>summary:focus-visible{outline:3px solid #f5b400;outline-offset:2px}
.k-drawer[open]>summary{inset-block-end:auto;inset-block-start:10px;inset-inline-end:12px;z-index:2}
.k-dbody{pointer-events:auto;position:fixed;inset-block:0;inset-inline-end:0;width:min(380px,100vw);background:var(--panel);border-inline-start:1px solid var(--border-strong);box-shadow:0 0 24px rgba(0,0,0,.18);overflow:auto;padding:64px 18px 24px;font-size:14px}
.k-dbody h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);margin:18px 0 8px}.k-dbody h3:first-child{margin-top:0}
.k-chips{display:flex;flex-wrap:wrap;gap:6px}.k-chip{font:12px/1 var(--mono);background:var(--panel-3);border:1px solid var(--border);border-radius:999px;padding:7px 10px;min-height:32px}
.k-chip:hover,.k-chip:focus-visible{border-color:var(--accent);outline:none}
.k-outs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}.k-outs button{font:12px/1.2 var(--mono);text-align:start;background:var(--panel-2);border:1px solid var(--border-strong);border-radius:6px;padding:8px;min-height:36px}
.k-radio{display:flex;gap:8px;align-items:center;padding:4px 0}.k-radio input{accent-color:var(--accent)}
.k-links{display:flex;flex-wrap:wrap;gap:6px 14px}
.k-fid{font-size:13px;color:var(--muted)}.k-fid b{color:var(--text);font-weight:600}
@media (max-width:600px){.k-dbody{inset-block-start:auto;width:100vw;max-height:78vh;border-inline-start:0;border-block-start:1px solid var(--border-strong);border-radius:14px 14px 0 0;padding-top:60px}
.k-drawer[open]>summary{inset-block-start:auto;inset-block-end:calc(78vh - 52px)}}
/* modal (3DS) */
.k-modal{position:fixed;inset:0;z-index:35;background:rgba(10,12,16,.55);display:grid;place-items:center;padding:16px}
.k-mbox{position:relative;background:var(--panel);border-radius:12px;width:min(420px,100%);min-height:420px;box-shadow:0 10px 40px rgba(0,0,0,.35);overflow:hidden;display:flex;flex-direction:column}
.k-mhead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-block-end:1px solid var(--border);font-weight:600;font-size:14px}
.k-mx{border:0;background:none;font-size:20px;line-height:1;width:36px;height:36px;border-radius:6px}.k-mx:hover{background:var(--panel-2)}
.k-acs{flex:1;width:100%;min-height:420px;border:0;background:var(--panel)}
.k-loading{flex:1;display:none;align-items:center;justify-content:center;gap:10px;color:var(--muted)}.k-loading .k-spin{display:inline-block;border-color:var(--border-strong);border-top-color:var(--accent)}
.k-wait .k-loading{display:flex}.k-wait .k-acs{display:none}
/* result / bank / otp */
.k-result{text-align:center;padding:28px 20px}.k-result h1{font-size:22px;margin:10px 0 6px}.k-result p{color:var(--muted);margin:0 0 16px}
.k-icon{width:52px;height:52px;border-radius:50%;display:inline-grid;place-items:center;font-size:26px;font-weight:700}
.k-icon.ok{background:var(--ok-soft);color:var(--ok)}.k-icon.bad{background:var(--bad-soft);color:var(--bad)}.k-icon.warn{background:var(--warn-soft);color:var(--warn)}.k-icon.info{background:var(--accent-soft);color:var(--accent-text)}
.k-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:10px 16px;border-radius:6px;border:1px solid var(--border-strong);background:var(--panel-2);text-decoration:none;color:inherit;font-weight:500}
.k-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.k-btn.bad{color:var(--bad)}.k-btn.wide{width:100%}
.k-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
.k-bank{max-width:460px;margin:0 auto}.k-bank .k-head{background:var(--panel-2)}
.k-otp{font:22px/1.2 var(--mono);letter-spacing:.3em;text-align:center!important}
body.embed{background:transparent;min-height:0}body.embed .k-wrap{padding:0;max-width:none}body.embed .k-card{max-width:none}
html.k-frame body{min-height:0}html.k-frame .k-wrap{padding:12px}
`;
