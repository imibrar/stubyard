(() => {
  if (window.top !== window) return;
  const q = new URLSearchParams(location.search);
  if (q.has('nowidget')) return;
  const host = document.createElement('stubyard-widget');
  host.setAttribute('data-stubyard-widget', '1');
  const st = host.style;
  st.setProperty('all', 'initial');
  st.position = 'fixed'; st.right = '16px'; st.bottom = '16px'; st.left = 'auto'; st.top = 'auto';
  st.width = '340px'; st.height = '300px'; st.zIndex = '2147483647'; st.display = 'block'; st.margin = '0'; st.padding = '0'; st.border = '0';
  const root = host.attachShadow({ mode: 'closed' });
  const f = document.createElement('iframe');
  if (q.get('allow') !== 'none') f.allow = q.get('allow') || 'clipboard-write; local-network-access';
  f.src = chrome.runtime.getURL('widget.html') + '#' + encodeURIComponent(JSON.stringify({ page: location.href, hub: q.get('hub') || 'http://127.0.0.1:41803' }));
  f.style.border = '0'; f.style.width = '100%'; f.style.height = '100%'; f.style.display = 'block'; f.style.background = '#fff';
  root.append(f);
  document.documentElement.append(host);
  const usePopover = q.has('popover');
  if (usePopover) { host.popover = 'manual'; st.inset = 'auto 16px 16px auto'; host.showPopover(); }
  const key = 'content:' + location.href; let loads = 0;
  const rep = (o) => chrome.storage.local.get(key).then((r) => chrome.storage.local.set({ [key]: { ...(r[key] || {}), ...o } }));
  f.addEventListener('load', () => { loads++; rep({ frameLoad: Date.now(), frameLoads: loads }); });
  f.addEventListener('error', () => rep({ frameError: Date.now() }));
  setTimeout(() => { const cs = getComputedStyle(host); rep({ hostPosition: cs.position, hostWidth: cs.width, hostRight: cs.right }); }, 300);
  let raised = 0;
  if (usePopover && q.has('reraise')) setInterval(() => {
    const modal = document.querySelector('dialog:modal');
    if (modal && raised < 1) { host.hidePopover(); host.showPopover(); raised++; rep({ reraised: true }); }
  }, 200);
  if (q.has('move')) setInterval(() => { const modal = document.querySelector('dialog:modal'); if (modal && host.parentNode !== modal) { const how = typeof modal.moveBefore === 'function' ? 'moveBefore' : 'append'; if (how === 'moveBefore') modal.moveBefore(host, null); else modal.append(host); rep({ moved: how }); } }, 200);
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'spike') return;
    port.onMessage.addListener((m) => port.postMessage({ echo: m, from: 'content', href: location.href }));
  });
  chrome.runtime.onMessage.addListener((m, _s, send) => {
    if (m && m.type === 'suspend') { st.visibility = 'hidden'; requestAnimationFrame(() => requestAnimationFrame(() => send({ ok: true }))); return true; }
    if (m && m.type === 'resume') { st.visibility = ''; send({ ok: true }); }
    return false;
  });
})();