#!/usr/bin/env python3
# Floating widget, phase 3 (security hardening, after the Fable review): a real headless Chrome check of the BUILT
# extension against a running throwaway stubyard (default http://127.0.0.1:41900) and fixture app pages served here on
# 127.0.0.1:41811 (the run's origin) and 127.0.0.1:41812 (another origin). Not part of npm test. Build both first:
#   ./scripts/npm.sh run build -w @stubyard/extension && ./scripts/npm.sh run build:test -w @stubyard/extension
#   python3 -I packages/extension/test/widget-spike/widget3.py [OUT_DIR] [HUB_URL]
# It loads the production build (dist/): nothing here needs the test hook, and one check is that it is not there.
# What it checks:
#  - a page that defines the custom element <stubyard-widget> and calls attachInternals (the reviewer's repro) gets
#    nothing: the host is a plain <div data-stubyard-widget>, never upgraded, attachInternals on it throws;
#  - the page restyles the host (opacity 0 !important, transform, inert): the host puts its own style back;
#  - opacity on <html> (out of the host's reach): a real mouse click on Done is ignored and the card says
#    "Widget hidden by the page"; once the page is visible again (300 ms) the click works;
#  - the page-side live region only says generic things (no step title in the page's DOM);
#  - widget.html framed by the page without a token loads no app bundle (boot check); with a made-up token or with
#    the real token copied from the widget's frame (single-use, already spent) it gets no step;
#  - "Show on this tab" is dropped when the tab goes to another origin;
#  - the production worker has no self.__stubyardCommand test hook.

import os, re, sys, json, time, threading, subprocess, http.server, socketserver, fcntl, traceback, tempfile, urllib.request, base64, select, socket

WS = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.abspath(os.path.join(WS, '..', '..', 'dist'))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='stubyard-widget3-')
HUB = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:41900'
os.makedirs(OUT, exist_ok=True)
APP = 'http://127.0.0.1:41811'
PROXY_PORT = 41901
FILLER = ''.join('<p>Paragraph %d of the app page. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>' % i for i in range(30))
FORM = '<form onsubmit="return false"><label>Full name <input name="name"></label><br><label>Email <input name="email" type="email"></label><br><button type="submit">Submit</button></form>'
DIALOG = ('<button id="open" onclick="document.getElementById(\'d\').showModal()">Open dialog</button>'
          '<dialog id="d"%s><form method="dialog"><p>Native modal dialog</p><label>Field <input id="dlg-in"></label> <button value="ok">Close</button></form></dialog>')
STICKY = FORM + FILLER + '<button id="sticky" type="submit" form="f2" style="position:fixed;right:24px;bottom:24px;padding:14px 28px;font-size:16px;background:#2563eb;color:#fff;border:0;border-radius:8px">Save order</button><form id="f2" onsubmit="return false"></form>'
FRAMES = ''.join('<iframe srcdoc="<p>frame %d</p><button>Inner</button>" style="width:180px;height:90px"></iframe>' % i for i in range(20)) + ''.join('<iframe src="/form" style="width:180px;height:90px"></iframe>' for _ in range(5))
ATTACK = ('<script>window.__upgraded = 0; window.__internals = null;'
  'customElements.define("stubyard-widget", class extends HTMLElement { constructor() { super(); window.__upgraded++; try { window.__internals = this.attachInternals(); } catch (e) {} } });'
  '</script>')
PAGES = {
  '/form': ('Sign up', FORM + FILLER, {}),
  '/attack': ('Attack', ATTACK + FORM + FILLER, {}),
}
class App(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    path = self.path.split('?')[0]
    if path not in PAGES: return self.send_error(404)
    title, body, headers = PAGES[path]
    rtl = False
    html = '<!doctype html><html%s><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>%s</title></head><body style="font:15px/1.5 system-ui;margin:24px;background:#f4f6fb"><h2>%s</h2>%s</body></html>' % (' dir="rtl" lang="ar"' if rtl else '', title, title, body)
    b = html.encode()
    self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Cache-Control', 'max-age=0')
    for k, v in headers.items(): self.send_header(k, v)
    self.end_headers(); self.wfile.write(b)
class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
servers = []
for port in (41811, 41812):
  s = TS(('127.0.0.1', port), App); threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)
OTHER = 'http://127.0.0.1:41812'

# ---- a stoppable TCP proxy in front of the hub ("the hub went offline") ----
class Proxy:
  def __init__(self, port, target):
    self.port = port; self.target = target; self.sock = None; self.conns = []; self.live = False
  def start(self):
    self.sock = socket.socket(); self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    self.sock.bind(('127.0.0.1', self.port)); self.sock.listen(64); self.live = True
    threading.Thread(target=self.accept, args=(self.sock,), daemon=True).start()
  def accept(self, sock):
    while True:
      try: c, _ = sock.accept()
      except OSError: return
      if not self.live or sock is not self.sock:
        c.close(); return
      try: u = socket.create_connection(self.target)
      except OSError: c.close(); continue
      self.conns += [c, u]
      for a, b in ((c, u), (u, c)): threading.Thread(target=self.pump, args=(a, b), daemon=True).start()
  def pump(self, a, b):
    try:
      while True:
        d = a.recv(65536)
        if not d: break
        b.sendall(d)
    except OSError: pass
    for x in (a, b):
      try: x.shutdown(socket.SHUT_RDWR)
      except OSError: pass
  def stop(self):
    self.live = False
    # shutdown() first: close() alone does not wake a thread blocked in accept(), and the port would keep listening.
    for f in (lambda: self.sock.shutdown(socket.SHUT_RDWR), lambda: self.sock.close()):
      try: f()
      except (OSError, AttributeError): pass
    for x in self.conns:
      try: x.shutdown(socket.SHUT_RDWR); x.close()
      except OSError: pass
    self.conns = []
hub_host = HUB.split('//')[1].split(':')[0]; hub_port = int(HUB.rsplit(':', 1)[1].split('/')[0])
proxy = Proxy(PROXY_PORT, (hub_host, hub_port))
PROXY = 'http://127.0.0.1:%d' % PROXY_PORT

def api(method, path, body=None):
  req = urllib.request.Request(HUB + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
  try:
    with urllib.request.urlopen(req, timeout=10) as r:
      t = r.read().decode(); return json.loads(t) if t else None
  except urllib.error.HTTPError as e:
    raise RuntimeError('%s %s: %s %s' % (method, path, e.code, e.read().decode()[:600]))

P = 'widget3-qa-%d' % int(time.time())
api('POST', '/api/projects', {'name': 'Widget 3 QA', 'slug': P, 'settings': {'appOrigins': [APP]}})
bundle = {
  'format': 'stubyard-storyboards', 'version': 1,
  'users': [{'email': 'ada@example.test', 'name': 'Ada Admin', 'role': 'admin', 'password': 'pw-123456'}],
  'storyboards': [
    {'slug': 'tracked', 'name': 'Widget 3 tracked', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}], 'steps': [{'kind': 'instruction', 'title': 'Step number %d' % i, 'intent': 'Do thing %d.' % i} for i in range(1, 15)]},
  ],
}
api('POST', '/api/projects/%s/storyboards/import' % P, {'bundle': bundle})
def start(sb, mode='tracked'): return api('POST', '/api/projects/%s/walkthroughs' % P, {'storyboard': sb, 'origin': APP, 'mode': mode})
def getw(wid): return api('GET', '/api/projects/%s/walkthroughs/%s' % (P, wid))
W = start('tracked')
def status_of(i): return getw(W['id'])['steps'][i]['status']

# ---- Chrome over a CDP pipe ----
r1, w1 = os.pipe(); r2, w2 = os.pipe()
def pre():
  a = fcntl.fcntl(r1, fcntl.F_DUPFD, 20); b = fcntl.fcntl(w2, fcntl.F_DUPFD, 20); os.dup2(a, 3); os.dup2(b, 4)
prof = tempfile.mkdtemp(prefix='stubyard-widget3-prof-')
args = ['google-chrome', '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + prof,
        '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank']
proc = subprocess.Popen(args, preexec_fn=pre, close_fds=False, stdout=subprocess.DEVNULL, stderr=open(os.path.join(OUT, 'chrome.log'), 'w'))
os.close(r1); os.close(w2)
out = os.fdopen(w1, 'wb', buffering=0); inp = os.fdopen(r2, 'rb', buffering=0)
buf = b''; mid = 0
def send(method, params=None, session=None, timeout=20):
  global mid, buf
  mid += 1; i = mid; m = {'id': i, 'method': method, 'params': params or {}}
  if session: m['sessionId'] = session
  out.write(json.dumps(m).encode() + b'\0')
  end = time.time() + timeout
  while True:
    while b'\0' not in buf:
      left = end - time.time()
      if left <= 0 or not select.select([inp], [], [], left)[0]: raise TimeoutError(method + ': no answer')
      c = inp.read(65536)
      if not c: raise EOFError('chrome closed')
      buf += c
    raw, buf = buf.split(b'\0', 1); msg = json.loads(raw)
    if msg.get('id') == i:
      if 'error' in msg: raise RuntimeError(method + ': ' + json.dumps(msg['error']))
      return msg.get('result', {})
def ev(session, expr, timeout=8):
  r = send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True}, session, timeout)
  if 'exceptionDetails' in r: raise RuntimeError('eval: ' + json.dumps(r['exceptionDetails'])[:500])
  return r.get('result', {}).get('value')
def wait_for(fn, timeout=8, step=0.2):
  end = time.time() + timeout; last = None
  while time.time() < end:
    try:
      last = fn()
      if last: return last
    except Exception as e:
      last = e
    time.sleep(step)
  raise AssertionError('timed out: %r' % (last,))

R = {'checks': {}, 'shots': []}
def check(name, ok, detail=None):
  R['checks'][name] = {'ok': bool(ok), 'detail': detail}
  print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else '  ' + json.dumps(detail, ensure_ascii=False)[:300]), flush=True)
def section(name, fn):
  try: fn()
  except Exception:
    R['checks'][name + ' (crashed)'] = {'ok': False, 'detail': traceback.format_exc()[-1500:]}
    print('FAIL %s (crashed)\n%s' % (name, traceback.format_exc()[-1500:]), flush=True)

try:
  ext = send('Extensions.loadUnpacked', {'path': DIST})['id']; R['extId'] = ext
  WIDGET = 'chrome-extension://%s/widget.html' % ext
  PANEL = 'chrome-extension://%s/sidepanel.html' % ext
  def attach(t):
    s = send('Target.attachToTarget', {'targetId': t, 'flatten': True})['sessionId']; send('Runtime.enable', {}, s); send('Page.enable', {}, s); return s
  ctl = {}
  def controller():
    t = send('Target.createTarget', {'url': PANEL, 'newWindow': True})['targetId']; time.sleep(1); ctl['t'] = t; ctl['s'] = attach(t)
  controller()
  def cx(expr): return ev(ctl['s'], expr)
  cx('chrome.storage.local.set({apiUrl: %s, widgetHintSeen: true})' % json.dumps(HUB))
  pt = send('Target.createTarget', {'url': APP + '/form', 'newWindow': True})['targetId']; ps = attach(pt)
  time.sleep(1)
  tab = json.loads(cx('chrome.tabs.query({url: "%s/*"}).then(t => JSON.stringify({id: t[0].id, w: t[0].windowId}))' % APP))
  TID, WID = tab['id'], tab['w']
  def open_run(wid):
    a = {'project': P, 'id': wid, 'origins': [APP]}
    cx('chrome.storage.local.get("activeWalkthroughByWindow").then(r => chrome.storage.local.set({activeWalkthroughByWindow: {...(r.activeWalkthroughByWindow || {}), [%d]: %s}}))' % (WID, json.dumps(a)))
  def host_count(s=None): return ev(s or ps, 'document.querySelectorAll("[data-stubyard-widget]").length')
  def host_present(s=None): return host_count(s) > 0
  frame_cache = {}
  def frame_sessions():
    out = []
    for t in send('Target.getTargets')['targetInfos']:
      if t['type'] == 'iframe' and t['url'].startswith(WIDGET):
        tid = t['targetId']
        if tid not in frame_cache:
          try: frame_cache[tid] = attach(tid)
          except (TimeoutError, RuntimeError): continue
        out.append(frame_cache[tid])
    return out
  def fs_wait(text, timeout=12, absent=False):
    seen = {}
    def f():
      for s in reversed(frame_sessions()):
        try: body = ev(s, 'document.body.innerText')
        except (TimeoutError, RuntimeError): continue
        seen['body'] = body
        if (text not in (body or '')) if absent else (text in (body or '')): return s
      return None
    try: return wait_for(f, timeout)
    except AssertionError:
      raise AssertionError('widget text %s %r; last text: %r' % ('still has' if absent else 'has no', text, (seen.get('body') or '')[:300]))
  def click_btn(s, label):
    time.sleep(0.35)  # the frame takes clicks once it has been visible 300 ms (click gate, phase 3)
    return ev(s, '(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === %s || b.getAttribute("aria-label") === %s); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "ok"; })()' % (json.dumps(label), json.dumps(label)))
  def shot(name):
    d = send('Page.captureScreenshot', {'format': 'png'}, ps)['data']
    p = os.path.join(OUT, name + '.png'); open(p, 'wb').write(base64.b64decode(d)); R['shots'].append(p); return p
  def metrics(w, h, dsf=1):
    send('Emulation.setDeviceMetricsOverride', {'width': w, 'height': h, 'deviceScaleFactor': dsf, 'mobile': w < 480}, ps)
  def scheme(v):
    feats = [{'name': 'prefers-color-scheme', 'value': v}] if v else []
    send('Emulation.setEmulatedMedia', {'features': feats}, ps)
    for s in frame_sessions():
      try: send('Emulation.setEmulatedMedia', {'features': feats}, s)
      except Exception: pass
  def nav(path, wait=1.5):
    send('Page.navigate', {'url': APP + path}, ps); time.sleep(wait)
  # The host's closed shadow root, seen through DevTools (pierce): the iframe box and the live region.
  def nodes():
    root = send('DOM.getDocument', {'depth': -1, 'pierce': True}, ps)['root']
    res = []
    def walk(n, in_host=False):
      in_host = in_host or 'data-stubyard-widget' in (n.get('attributes') or [])[::2]
      res.append((n, in_host))
      for c in (n.get('children') or []): walk(c, in_host)
      for c in (n.get('shadowRoots') or []): walk(c, in_host)
    walk(root); return res
  def attrs(n):
    a = n.get('attributes') or []; return dict(zip(a[::2], a[1::2]))
  def frame_box():
    for n, inh in nodes():
      if n.get('nodeName') == 'IFRAME' and 'widget.html' in attrs(n).get('src', ''):
        q = send('DOM.getBoxModel', {'nodeId': n['nodeId']}, ps)['model']['border']
        return {'x': q[0], 'y': q[1], 'w': q[2] - q[0], 'h': q[5] - q[1]}
    return None
  def host_node(pred):
    for n, inh in nodes():
      if inh and pred(n, attrs(n)): return n
    return None
  def live_text():
    n = host_node(lambda n, a: a.get('aria-live') == 'polite')
    return send('DOM.getOuterHTML', {'nodeId': n['nodeId']}, ps)['outerHTML'] if n else None
  def handle_html():
    n = host_node(lambda n, a: a.get('aria-roledescription') == 'move handle')
    return send('DOM.getOuterHTML', {'nodeId': n['nodeId']}, ps)['outerHTML'] if n else ''
  def page_click(x, y):
    send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y}, ps)
    for t in ('mousePressed', 'mouseReleased'):
      send('Input.dispatchMouseEvent', {'type': t, 'x': x, 'y': y, 'button': 'left', 'buttons': 1 if t == 'mousePressed' else 0, 'clickCount': 1}, ps)
  def real_click(fs, label):
    # A real mouse click at the button's place on the page (it goes through any inert or modal layer like a user's).
    fb = frame_box()
    r = json.loads(ev(fs, '(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === %s || b.getAttribute("aria-label") === %s); if (!b) return "null"; const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2}); })()' % (json.dumps(label), json.dumps(label))))
    if not r or not fb: return False
    page_click(fb['x'] + r['x'], fb['y'] + r['y']); return True
  def key(k, code=None, vk=0, s=None):
    for t in ('keyDown', 'keyUp'):
      send('Input.dispatchKeyEvent', {'type': t, 'key': k, 'code': code or k, 'windowsVirtualKeyCode': vk}, s or ps)
  def vp(): return json.loads(ev(ps, 'JSON.stringify({w: document.documentElement.clientWidth, h: innerHeight})'))
  def done_current(title):
    fs = fs_wait(title); click_btn(fs, 'Done')


  open_run(W['id'])
  wait_for(host_present, 10)
  fs = fs_wait('Step number 1')

  # ---- 1. Custom element + attachInternals (review item 2) ----
  def custom_element():
    nav('/attack'); fs_wait('Step number')
    r = json.loads(ev(ps, '''JSON.stringify((() => { const h = document.querySelector("[data-stubyard-widget]");
      let threw = false; try { h.attachInternals(); } catch (e) { threw = true; }
      return { tag: h.tagName, upgraded: window.__upgraded, internals: !!window.__internals, shadow: h.shadowRoot, threw,
               custom: document.querySelectorAll("stubyard-widget").length }; })())'''))
    check('custom element <stubyard-widget> defined by the page: the host is a plain div, never upgraded, attachInternals throws',
          r['tag'] == 'DIV' and r['upgraded'] == 0 and not r['internals'] and r['shadow'] is None and r['threw'] and r['custom'] == 0, r)
  section('custom-element', custom_element)

  # ---- 2. The page restyles the host (review item 1) ----
  def restyle():
    nav('/form'); fs_wait('Step number')
    before = ev(ps, 'document.querySelector("[data-stubyard-widget]").getAttribute("style")')
    ev(ps, '''(() => { const h = document.querySelector("[data-stubyard-widget]");
      h.style.setProperty("opacity", "0", "important"); h.style.setProperty("transform", "translate(-900px,-500px)", "important");
      h.setAttribute("inert", ""); h.className = "sneaky"; })()''')
    time.sleep(0.3)
    after = json.loads(ev(ps, '''JSON.stringify((() => { const h = document.querySelector("[data-stubyard-widget]"); const cs = getComputedStyle(h);
      return { same: h.getAttribute("style") === %s, opacity: cs.opacity, transform: cs.transform, inert: h.hasAttribute("inert"), cls: h.className }; })())''' % json.dumps(before)))
    check('opacity / transform / inert / class on the host are put back at once', after['same'] and after['opacity'] == '1' and after['transform'] == 'none' and not after['inert'] and after['cls'] == '', after)
  section('restyle', restyle)

  # ---- 3. Clickjacking through <html> opacity: the click gate (IntersectionObserver v2) ----
  def clickjack():
    nav('/form'); fs = fs_wait('Step number'); time.sleep(0.6)
    before = getw(W['id'])['currentStepId']
    ev(ps, 'document.documentElement.style.opacity = "0.01"'); time.sleep(0.6)
    real_click(fs, 'Done'); time.sleep(1.0)
    after = getw(W['id'])['currentStepId']
    body = ev(fs, 'document.body.innerText')
    check('the page made itself (and the card) nearly transparent: a real click on Done is ignored', after == before, {'before': before, 'after': after})
    check('the card says it is hidden by the page and points to the panel', 'Widget hidden by the page' in (body or ''), (body or '')[:200])
    shot('clickjack-blocked-1280')
    ev(ps, 'document.documentElement.style.opacity = ""'); time.sleep(1.2)
    real_click(fs, 'Done')
    moved = False
    try: moved = bool(wait_for(lambda: getw(W['id'])['currentStepId'] != before, 5))
    except AssertionError: pass
    check('visible again (300 ms): the same real click works', moved)
    # A page element laid over the card (occlusion) is caught the same way.
    fs = fs_wait('Step number'); time.sleep(0.4)
    before = getw(W['id'])['currentStepId']
    fb = frame_box()
    ev(ps, '''(() => { const d = document.createElement("div"); d.id = "cover"; Object.assign(d.style, {position: "fixed", left: "%dpx", top: "%dpx", width: "%dpx", height: "%dpx", background: "rgba(255,255,255,0.02)", zIndex: "2147483647", pointerEvents: "none"}); document.documentElement.append(d); })()''' % (fb['x'], fb['y'], fb['w'], fb['h']))
    time.sleep(0.6)
    real_click(fs, 'Done'); time.sleep(1.0)
    check('a page element laid over the card (pointer-events: none): a real click on Done is ignored', getw(W['id'])['currentStepId'] == before)
    ev(ps, 'document.getElementById("cover").remove()'); time.sleep(0.8)
  section('clickjack', clickjack)

  # ---- 4. No step text in the page's DOM (review item 2) ----
  def page_dom():
    nav('/form'); fs_wait('Step number'); time.sleep(0.5)
    fs = fs_wait('Step number'); title = ev(fs, 'document.querySelector(".w-title").textContent')
    click_btn(fs, 'Done'); time.sleep(1.5)
    lt = live_text() or ''
    html = ''
    for n, inh in nodes():
      if inh and n.get('nodeName') != 'IFRAME':
        try: html += send('DOM.getOuterHTML', {'nodeId': n['nodeId']}, ps)['outerHTML']
        except Exception: pass
        break
    check('the page-side live region is generic; no step title anywhere in the host', 'stubyard step updated' in lt and 'Step number' not in html, {'live': re.sub('<[^>]+>', '', lt)[:120], 'title': title})
  section('page-dom', page_dom)

  # ---- 5. widget.html framed by the page (review items 2 and 5) ----
  def framed():
    nav('/form'); fs_wait('Step number'); time.sleep(0.5)
    real_url = [t['url'] for t in send('Target.getTargets')['targetInfos'] if t['type'] == 'iframe' and t['url'].startswith(WIDGET)]
    token = real_url[0].split('token=')[1] if real_url and 'token=' in real_url[0] else ''
    known = set(t['targetId'] for t in send('Target.getTargets')['targetInfos'])
    ev(ps, '''(() => { for (const [id, h] of [["f-none", ""], ["f-fake", "#token=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], ["f-real", %s]]) {
      const f = document.createElement("iframe"); f.id = id; f.src = %s + h; f.style.cssText = "width:340px;height:200px"; document.body.prepend(f); } })()''' % (json.dumps('#token=' + token), json.dumps(WIDGET)))
    time.sleep(3.5)
    res = {}
    for t in send('Target.getTargets')['targetInfos']:
      if t['type'] != 'iframe' or t['targetId'] in known or not t['url'].startswith(WIDGET): continue
      s = attach(t['targetId'])
      info = json.loads(ev(s, 'JSON.stringify({res: performance.getEntriesByType("resource").map(e => e.name.split("/").pop()), text: document.body.innerText.slice(0, 200), root: document.getElementById("root").innerHTML.length})'))
      key = 'none' if 'token=' not in t['url'] else ('real' if t['url'].endswith(token) else 'fake')
      res[key] = info
    none = res.get('none') or {}
    check('widget.html framed without a token: no app bundle is loaded, nothing rendered', none and not any(r.startswith('main-') for r in none.get('res', [])) and none.get('root') == 0, none)
    check('with a made-up token: no step (the worker refuses the hello)', 'fake' in res and 'Step number' not in res['fake']['text'], res.get('fake'))
    check('with the real token copied from the widget frame: no step (single-use, already spent)', token and 'real' in res and 'Step number' not in res['real']['text'], {'token': token[:8], 'r': res.get('real')})
    fs = fs_wait('Step number')
    check('the real widget keeps working', bool(fs))
    ev(ps, '["f-none", "f-fake", "f-real"].forEach(id => document.getElementById(id).remove())')
  section('framed', framed)

  # ---- 6. "Show on this tab" is bound to its origin (review item 1) ----
  def show_override():
    nav('/form'); fs_wait('Step number')
    cx('chrome.storage.session.set({"widgetTabOverride:%d": {value: "show", origin: %s}})' % (TID, json.dumps(APP))); time.sleep(0.5)
    send('Page.navigate', {'url': OTHER + '/form'}, ps); time.sleep(2.5)
    present = host_present()
    left = json.loads(cx('chrome.storage.session.get("widgetTabOverride:%d").then(r => JSON.stringify(r["widgetTabOverride:%d"] || null))' % (TID, TID)))
    check('"Show on this tab" does not carry over to another origin (and is dropped)', not present and left is None, {'present': present, 'override': left})
    # The run's own origin still gets it.
    nav('/form'); wait_for(host_present, 8)
  section('show-override', show_override)

  # ---- 7. No test hook in the production worker (review item 6) ----
  def hook():
    sw = [t for t in send('Target.getTargets')['targetInfos'] if t['type'] == 'service_worker' and t['url'].startswith('chrome-extension://%s/' % ext)]
    s = send('Target.attachToTarget', {'targetId': sw[0]['targetId'], 'flatten': True})['sessionId']
    kind = ev(s, 'typeof self.__stubyardCommand')
    src = open(os.path.join(DIST, 'background.js')).read()
    check('the production worker has no self.__stubyardCommand (only the test build does)', kind == 'undefined' and '__stubyardCommand' not in src, kind)
  section('hook', hook)
except Exception:
  R['error'] = traceback.format_exc(); print(R['error'], flush=True)
finally:
  try: send('Browser.close', timeout=3)
  except Exception: pass
  time.sleep(0.5); proc.kill()
  for s in servers: s.shutdown()
  try: proxy.stop()
  except Exception: pass
json.dump(R, open(os.path.join(OUT, 'results.json'), 'w'), indent=1)
fails = [k for k, v in R['checks'].items() if not v['ok']]
print('%d checks, %d failed%s' % (len(R['checks']), len(fails), (': ' + ', '.join(fails)) if fails else ''))
print(OUT)
sys.exit(1 if fails or 'error' in R else 0)

