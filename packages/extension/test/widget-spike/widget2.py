#!/usr/bin/env python3
# Floating widget, phase 2 (polish and hardening): a real headless Chrome check of the BUILT extension
# (packages/extension/dist) against a running throwaway stubyard (default http://127.0.0.1:41900) and fixture app
# pages served here on 127.0.0.1:41811. Not part of npm test. Run:
#   python3 -I packages/extension/test/widget-spike/widget2.py [OUT_DIR] [HUB_URL]
# Needs google-chrome >= 133 (moveBefore). Optional: RADIX_JS=/path/to/radix.js (the bundled fixtures/radix-app.jsx,
# see spike.py); without it the Radix check is skipped. A TCP proxy on 127.0.0.1:41901 stands in for "the hub went
# offline" (it is stopped and started again). Screenshots and results.json go to OUT_DIR.
# What it checks:
#  - native <dialog>.showModal(): the host moves INTO the dialog (moveBefore, the frame is not reloaded), real mouse
#    clicks and typing in the card work while the page is inert, it moves back on close; also a dialog with a
#    transform (the host is a manual popover there, so it is not shifted or clipped);
#  - a Radix modal (focus trap): clicking and typing in the card work, the dialog stays open;
#  - auto-nudge: the card moves off a fixed Submit button in its corner (elementFromPoint finds the button);
#  - accessibility: Tab order (page fields, then the move handle, then the card), a visible focus ring on the handle,
#    step changes announced through the host's live region, reduced motion turns the slide-in off;
#  - 200% zoom, very long step text (clamped, no sideways scroll, capped height), RTL default corner;
#  - robustness: hub offline -> a clear "not reachable" line with a countdown, then recovery; two tabs of the same run
#    stay in sync; an iframe-heavy page gets one widget in the top frame only; extension reload replaces the widget;
#  - Settings: the per-site hide list removes the card; "Reset all positions" puts it back in its corner;
#  - the card and the pill in light and dark at 390/768/1280/1920.
import os, re, sys, json, time, threading, subprocess, http.server, socketserver, fcntl, traceback, tempfile, urllib.request, base64, select, socket

WS = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.abspath(os.path.join(WS, '..', '..', 'dist'))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='stubyard-widget2-')
HUB = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:41900'
RADIX = os.environ.get('RADIX_JS') or os.path.join(WS, 'fixtures', 'radix.js')
os.makedirs(OUT, exist_ok=True)
APP = 'http://127.0.0.1:41811'
PROXY_PORT = 41901
FILLER = ''.join('<p>Paragraph %d of the app page. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>' % i for i in range(30))
FORM = '<form onsubmit="return false"><label>Full name <input name="name"></label><br><label>Email <input name="email" type="email"></label><br><button type="submit">Submit</button></form>'
DIALOG = ('<button id="open" onclick="document.getElementById(\'d\').showModal()">Open dialog</button>'
          '<dialog id="d"%s><form method="dialog"><p>Native modal dialog</p><label>Field <input id="dlg-in"></label> <button value="ok">Close</button></form></dialog>')
STICKY = FORM + FILLER + '<button id="sticky" type="submit" form="f2" style="position:fixed;right:24px;bottom:24px;padding:14px 28px;font-size:16px;background:#2563eb;color:#fff;border:0;border-radius:8px">Save order</button><form id="f2" onsubmit="return false"></form>'
FRAMES = ''.join('<iframe srcdoc="<p>frame %d</p><button>Inner</button>" style="width:180px;height:90px"></iframe>' % i for i in range(20)) + ''.join('<iframe src="/form" style="width:180px;height:90px"></iframe>' for _ in range(5))
PAGES = {
  '/form': ('Sign up', FORM + FILLER, {}),
  '/sticky': ('Order', STICKY, {}),
  '/dialog': ('Dialog', DIALOG % '' + FILLER, {}),
  '/dialog-tx': ('Dialog with transform', DIALOG % ' style="position:fixed;left:50%;top:50%;margin:0;transform:translate(-50%,-50%);width:420px"' + FILLER, {}),
  '/radix': ('Radix', '<div id="root"></div><script src="/radix.js"></script>', {}),
  '/rtl': ('RTL', '<h1>صفحة التسجيل</h1>' + FORM + FILLER, {}),
  '/frames': ('Frames', FRAMES, {}),
}
class App(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    path = self.path.split('?')[0]
    if path == '/radix.js':
      if not os.path.exists(RADIX): return self.send_error(404)
      b = open(RADIX, 'rb').read()
      self.send_response(200); self.send_header('Content-Type', 'text/javascript'); self.end_headers(); self.wfile.write(b); return
    if path not in PAGES: return self.send_error(404)
    title, body, headers = PAGES[path]
    rtl = path == '/rtl'
    html = '<!doctype html><html%s><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>%s</title></head><body style="font:15px/1.5 system-ui;margin:24px;background:#f4f6fb"><h2>%s</h2>%s</body></html>' % (' dir="rtl" lang="ar"' if rtl else '', title, title, body)
    b = html.encode()
    self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Cache-Control', 'max-age=0')
    for k, v in headers.items(): self.send_header(k, v)
    self.end_headers(); self.wfile.write(b)
class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
servers = []
s = TS(('127.0.0.1', 41811), App); threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)

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

P = 'widget2-qa-%d' % int(time.time())
api('POST', '/api/projects', {'name': 'Widget 2 QA', 'slug': P, 'settings': {'appOrigins': [APP]}})
LONG_TITLE = ('Check that the very long confirmation banner ' + 'with many repeated words ' * 12)[:196] + ' end'
LONG_INTENT = ('Read the whole confirmation and compare every line with the expected order. ' * 10)[:780] + ' https://example.test/' + 'x' * 180
bundle = {
  'format': 'stubyard-storyboards', 'version': 1,
  'users': [{'email': 'ada@example.test', 'name': 'Ada Admin', 'role': 'admin', 'password': 'pw-123456'}],
  'storyboards': [
    {'slug': 'tracked', 'name': 'Widget 2 tracked', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}], 'steps': [{'kind': 'instruction', 'title': 'Step number %d' % i, 'intent': 'Do thing %d.' % i} for i in range(1, 15)]},
    {'slug': 'long', 'name': 'Widget 2 long text', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}], 'steps': [{'kind': 'instruction', 'title': LONG_TITLE, 'intent': LONG_INTENT, 'notes': 'n ' * 400}, {'kind': 'instruction', 'title': 'Short', 'intent': 'x'}]},
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
prof = tempfile.mkdtemp(prefix='stubyard-widget2-prof-')
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
      in_host = in_host or n.get('nodeName') == 'STUBYARD-WIDGET'
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

  # ---- 1. The visual set: card and pill, light and dark, 4 widths ----
  def visuals():
    for sch in ('light', 'dark'):
      scheme(sch); time.sleep(0.4)
      for (w, h) in ((390, 844), (768, 1024), (1280, 800), (1920, 1080)):
        metrics(w, h); time.sleep(0.7); scheme(sch); time.sleep(0.2); shot('card-%d-%s' % (w, sch))
      metrics(1280, 800); time.sleep(0.4)
      fs = fs_wait('Step number 1'); key('Escape', 'Escape', 27, fs); time.sleep(0.5)
      shot('pill-1280-%s' % sch)
      cx('chrome.tabs.query({active: true, windowId: %d}).then(([t]) => t)' % WID)
      ev(ps, '0')
      # expand again through the pill: a real click at its place (bottom-right, 44 px)
      v = vp(); page_click(v['w'] - 16 - 22, v['h'] - 16 - 22); time.sleep(0.5)
    scheme(None)
    check('card and pill shot in light and dark at 390/768/1280/1920', True)
  section('visuals', visuals)

  # ---- 2. Accessibility ----
  def a11y():
    nav('/form')
    fs_wait('Step number 1')
    ev(ps, 'document.activeElement && document.activeElement.blur(); window.focus()')
    # Tab order: name, email, Submit, then the widget's move handle (the host is last in the document).
    for _ in range(4): key('Tab', 'Tab', 9); time.sleep(0.1)
    active = ev(ps, 'document.activeElement.tagName')
    hh = handle_html()
    check('Tab order: page fields first, then the widget handle (focus enters the host)', active == 'STUBYARD-WIDGET', active)
    ring = re.search(r'box-shadow:([^;]*)', hh)
    ring = ring.group(1) if ring else ''
    check('the focused handle shows a focus ring (inset accent outline)', 'inset' in ring and '2px' in ring, ring)
    check('the handle has a role, a description and an accessible name', 'role="button"' in hh and 'aria-label="Move the stubyard widget' in hh and 'tabindex="0"' in hh, hh[:300])
    shot('focus-handle-1280')
    # Arrow keys move it; Home puts it back.
    b0 = frame_box(); key('ArrowUp', 'ArrowUp', 38); time.sleep(0.3); b1 = frame_box()
    check('ArrowUp on the handle moves the card 16 px', b0 and b1 and abs((b0['y'] - b1['y']) - 16) < 1.5, {'before': b0, 'after': b1})
    key('Home', 'Home', 36); time.sleep(0.3)
    # Step change announced through the live region.
    done_current('Step number 1'); time.sleep(1.2)
    lt = live_text() or ''
    check('a step change is announced (polite live region in the host)', 'Step 2 of 14' in lt and 'Step number 2' in lt, lt[:200])
    # Reduced motion: no slide-in.
    fs = fs_wait('Step number 2')
    send('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-reduced-motion', 'value': 'reduce'}]}, fs)
    anim = ev(fs, 'getComputedStyle(document.querySelector(".w-card")).animationName')
    send('Emulation.setEmulatedMedia', {'features': []}, fs)
    anim2 = ev(fs, 'getComputedStyle(document.querySelector(".w-card")).animationName')
    check('prefers-reduced-motion turns the slide-in off', anim == 'none' and anim2 != 'none', {'reduce': anim, 'normal': anim2})
    sizes = json.loads(ev(fs, 'JSON.stringify({body: getComputedStyle(document.body).fontSize, btn: getComputedStyle(document.querySelector(".footer button.primary")).fontSize, title: getComputedStyle(document.querySelector(".w-title")).fontSize})'))
    check('readable type: body and buttons 13 px, title 14 px', sizes['body'] == '13px' and sizes['btn'] == '13px' and sizes['title'] == '14px', sizes)
  section('a11y', a11y)

  # ---- 3. Auto-nudge off a fixed Submit button in the card's corner ----
  def avoid():
    nav('/form'); fs_wait('Step number')
    v = vp(); fb = frame_box()
    check('no button in the corner: the card stays bottom-right', fb and fb['x'] > v['w'] / 2 and fb['y'] > v['h'] / 3, fb)
    nav('/sticky'); fs_wait('Step number'); time.sleep(0.8)
    hit = ev(ps, '(() => { const b = document.getElementById("sticky").getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && (e.id || e.tagName); })()')
    fb = frame_box()
    check('the card moves off the page\'s fixed Submit button (it stays clickable)', hit == 'sticky', {'hit': hit, 'frame': fb})
    shot('avoid-sticky-1280')
    metrics(390, 844); time.sleep(1.2)
    hit = ev(ps, '(() => { const b = document.getElementById("sticky").getBoundingClientRect(); const e = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return e && (e.id || e.tagName); })()')
    check('bottom sheet (390 px) moves to the top edge off the button', hit == 'sticky', hit)
    shot('avoid-sticky-390')
    metrics(1280, 800); time.sleep(0.5)
  section('avoid', avoid)

  # ---- 4. Native <dialog>.showModal() ----
  def dialog(path, tag):
    nav(path); fs = fs_wait('Step number')
    ev(fs, 'window.__mark = 42')
    ev(ps, 'document.getElementById("d").showModal()'); time.sleep(0.8)
    parent = ev(ps, 'document.querySelector("[data-stubyard-widget]").parentElement.tagName')
    check('%s: the host moves into the open modal dialog' % tag, parent == 'DIALOG', parent)
    fs = fs_wait('Step number')
    kept = ev(fs, 'window.__mark') == 42
    check('%s: moved with moveBefore, the frame was not reloaded' % tag, kept)
    v = vp(); fb = frame_box()
    check('%s: the card is inside the viewport in its corner' % tag, fb and fb['x'] > v['w'] / 2 and fb['x'] + fb['w'] <= v['w'] and fb['y'] + fb['h'] <= v['h'], fb)
    shot('dialog-%s-1280' % tag)
    before = getw(W['id'])['currentStepId']
    title = ev(fs, 'document.querySelector(".w-title").textContent')
    real_click(fs, 'Done')
    moved = False
    try: moved = bool(wait_for(lambda: getw(W['id'])['currentStepId'] != before, 5))
    except AssertionError: pass
    check('%s: a real mouse click on Done in the card works while the page is inert' % tag, moved, title)
    time.sleep(1)  # the next step renders and the card is resized
    fs = fs_wait('Step number')
    real_click(fs, 'Add note'); time.sleep(0.5)
    send('Input.insertText', {'text': 'typed in a dialog'}, ps); time.sleep(0.3)
    val = ev(fs, '(document.querySelector("textarea") || {}).value')
    check('%s: typing in the card\'s note works' % tag, val == 'typed in a dialog', val)
    still = ev(ps, 'document.getElementById("d").open')
    ev(ps, 'document.getElementById("d").close()'); time.sleep(0.6)
    parent = ev(ps, 'document.querySelector("[data-stubyard-widget]").parentElement.tagName')
    kept = ev(fs_wait('Step number'), 'window.__mark') == 42
    check('%s: back on <html> when the dialog closes, frame kept' % tag, still and parent == 'HTML' and kept, {'parent': parent, 'kept': kept})
  section('dialog', lambda: dialog('/dialog', 'dialog'))
  section('dialog-tx', lambda: dialog('/dialog-tx', 'dialog-transform'))

  # ---- 5. Radix modal (focus trap) ----
  def radix():
    if not os.path.exists(RADIX):
      check('Radix modal: skipped (set RADIX_JS to the bundled fixtures/radix-app.jsx)', True); return
    nav('/radix', 2.5); fs = fs_wait('Step number')
    real_click(fs, 'Add note'); time.sleep(0.4)
    send('Input.insertText', {'text': 'radix ok'}, ps); time.sleep(0.3)
    val = ev(fs, '(document.querySelector("textarea") || {}).value')
    opened = ev(ps, 'window.__dialogOpen')
    check('Radix modal open: typing in the card works and the dialog stays open', val == 'radix ok' and opened is True, {'value': val, 'open': opened})
    shot('radix-1280')
  section('radix', radix)

  # ---- 6. Long text, 200% zoom, RTL ----
  def long_text():
    L = start('long'); open_run(L['id'])
    nav('/form'); fs = fs_wait('very long confirmation')
    time.sleep(0.5)
    m = json.loads(ev(fs, 'JSON.stringify({clamped: (() => { const t = document.querySelector(".w-title"); return t.scrollHeight > t.clientHeight + 2; })(), sideways: document.documentElement.scrollWidth > innerWidth + 1, h: innerHeight})'))
    v = vp(); fb = frame_box()
    check('very long text: title clamped, no sideways scroll, card at most 60% of the viewport', m['clamped'] and not m['sideways'] and fb['h'] <= v['h'] * 0.6 + 2, {'m': m, 'frame': fb, 'vp': v})
    shot('long-1280-light')
    metrics(390, 844); time.sleep(0.8); shot('long-390-light')
    # 200% zoom of a 1280x800 window: a 640x400 CSS viewport at 2 device pixels per px.
    metrics(640, 400, 2); time.sleep(1)
    v = vp(); fb = frame_box()
    check('200% zoom: the card fits the viewport and scrolls inside', fb and fb['x'] >= 0 and fb['x'] + fb['w'] <= v['w'] + 1 and fb['y'] >= 0 and fb['y'] + fb['h'] <= v['h'] + 1, {'frame': fb, 'vp': v})
    shot('zoom200-long')
    open_run(W['id']); time.sleep(1)
    fs_wait('Step number'); time.sleep(0.5); shot('zoom200-card')
    metrics(1280, 800); time.sleep(0.5)
  section('long', long_text)

  def rtl():
    nav('/rtl'); fs_wait('Step number'); time.sleep(0.5)
    v = vp(); fb = frame_box()
    check('RTL page: the card starts bottom-left', fb and fb['x'] < v['w'] / 2, fb)
    for sch in ('light', 'dark'):
      for (w, h) in ((390, 844), (1280, 800)):
        metrics(w, h); time.sleep(0.6); scheme(sch); time.sleep(0.3); shot('rtl-%d-%s' % (w, sch))
    scheme(None); metrics(1280, 800)
  section('rtl', rtl)

  # ---- 7. Hub offline -> clear state, retry, recovery ----
  def offline():
    try: offline_run()
    finally:
      cx('chrome.storage.local.set({apiUrl: %s})' % json.dumps(HUB)); proxy.stop()
  def offline_run():
    proxy.start()
    cx('chrome.storage.local.set({apiUrl: %s})' % json.dumps(PROXY))
    nav('/form'); fs_wait('Step number', 15)
    proxy.stop(); t0 = time.time()
    fs = fs_wait('not reachable', 20)
    took = round(time.time() - t0, 1)
    body = ev(fs, 'document.body.innerText')
    check('hub offline: a clear "not reachable" line with a countdown and Retry now', 'Retry' in body, {'after_s': took, 'text': body[:160]})
    shot('offline-1280')
    proxy.start(); t0 = time.time()
    fs_wait('not reachable', 40, absent=True)
    check('hub back: the widget recovers by itself', True, {'after_s': round(time.time() - t0, 1)})
  section('offline', offline)

  # ---- 8. Two tabs of the same run ----
  def two_tabs():
    nav('/form'); fs_wait('Step number')
    t2 = send('Target.createTarget', {'url': APP + '/sticky', 'newWindow': False})['targetId']; s2 = attach(t2)
    time.sleep(2)
    win2 = json.loads(cx('chrome.tabs.query({url: "%s/sticky"}).then(t => JSON.stringify(t.map(x => x.windowId)))' % APP))
    # The new tab must be in the run's window; move it there if Chrome put it elsewhere.
    if win2 and win2[0] != WID:
      cx('chrome.tabs.query({url: "%s/sticky"}).then(t => chrome.tabs.move(t[0].id, {windowId: %d, index: -1}))' % (APP, WID)); time.sleep(2)
    wait_for(lambda: host_present(s2), 10)
    before = getw(W['id'])['currentStepId']
    cur = [s for s in getw(W['id'])['steps'] if s['id'] == before][0]['title']
    nxt = 'Step number %d' % (int(cur.split()[-1]) + 1)
    fs = fs_wait(cur); click_btn(fs, 'Done')
    # A background tab closes its stream (hidden) and reloads when it becomes visible again: show each tab once.
    for t in (t2, pt):
      send('Target.activateTarget', {'targetId': t}); time.sleep(1.5)
    def both():
      n = 0
      for s in frame_sessions():
        try:
          if nxt in (ev(s, 'document.body.innerText') or ''): n += 1
        except Exception: pass
      return n >= 2
    ok = False
    try: ok = bool(wait_for(both, 10))
    except AssertionError: pass
    seen = []
    for s in frame_sessions():
      try: seen.append((ev(s, 'location.href + " | " + document.visibilityState + " | " + document.body.innerText') or '')[-300:])
      except Exception as e: seen.append(str(e)[:60])
    diag = None
    if not ok:
      diag = cx('Promise.all([chrome.tabs.query({}), chrome.storage.session.get(null), chrome.storage.local.get(["activeWalkthroughByWindow", "widgetHiddenOrigins", "widgetEnabled"])]).then(r => JSON.stringify({tabs: r[0].map(t => [t.id, t.windowId, t.url, t.active]), s: r[1], l: r[2]}))')
    check('two tabs of the same run: Done in one shows the next step in both', ok, {'next': nxt, 'win2': win2, 'WID': WID, 'frames': [x[-120:] for x in seen], 'diag': diag})
    send('Target.closeTarget', {'targetId': t2}); time.sleep(0.5)
  section('two-tabs', two_tabs)

  # ---- 9. Iframe-heavy page ----
  def frames():
    nav('/frames', 2.5); fs_wait('Step number')
    inner = ev(ps, '[...document.querySelectorAll("iframe")].reduce((n, f) => { try { return n + f.contentDocument.querySelectorAll("[data-stubyard-widget]").length; } catch { return n; } }, 0)')
    check('iframe-heavy page: one widget, top frame only', host_count() == 1 and inner == 0, {'top': host_count(), 'inFrames': inner})
  section('frames', frames)

  # ---- 10. Settings: per-site hide list and position reset ----
  def settings():
    nav('/form'); fs_wait('Step number')
    cx('chrome.storage.local.set({widgetHiddenOrigins: [%s]})' % json.dumps(APP))
    gone = False
    try: gone = bool(wait_for(lambda: not host_present(), 6))
    except AssertionError: pass
    check('Settings hide list: the card leaves that site', gone)
    # The panel's Settings screen with the list (the controller page is the panel).
    ev(ctl['s'], '(() => { const b = [...document.querySelectorAll("button")].find(b => /settings/i.test(b.textContent) || /settings/i.test(b.title || "")); b && b.click(); })()'); time.sleep(1)
    sh = send('Page.captureScreenshot', {'format': 'png'}, ctl['s'])['data']; p = os.path.join(OUT, 'panel-settings.png'); open(p, 'wb').write(base64.b64decode(sh)); R['shots'].append(p)
    txt = ev(ctl['s'], 'document.body.innerText') or ''
    check('panel Settings lists the hidden site with Show again', APP in txt and 'Show again' in txt, txt[txt.find('On-page'):][:300])
    ev(ctl['s'], '(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Show again"); b && b.click(); })()')
    wait_for(host_present, 8)
    check('Show again brings it back', True)
    # A saved place, then "Reset all positions" in the panel.
    cx('chrome.storage.local.set({widgetPlacementByOrigin: {%s: {corner: "top-left", x: 40, y: 40, collapsed: false}}})' % json.dumps(APP))
    nav('/form'); fs_wait('Step number'); time.sleep(0.5)
    fb = frame_box()
    tl = fb and fb['y'] < 200  # top (top-left, or top-right while it keeps clear of the form's Submit button)
    time.sleep(0.5)
    ev(ctl['s'], '(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Reset all positions"); b && b.click(); })()'); time.sleep(1)
    v = vp(); fb2 = frame_box()
    saved = json.loads(cx('chrome.storage.local.get("widgetPlacementByOrigin").then(r => JSON.stringify(r.widgetPlacementByOrigin || {}))'))
    check('Reset all positions: forgotten, and the open card goes back to its corner at once', tl and saved == {} and fb2['x'] > v['w'] / 2 and fb2['y'] > v['h'] / 3, {'before': fb, 'after': fb2, 'saved': saved})
  section('settings', settings)

  # ---- 11. Extension reload: the old card goes, a new one comes ----
  def reload():
    nav('/form'); fs_wait('Step number')
    try: ev(ctl['s'], 'chrome.runtime.reload()', timeout=3)
    except Exception: pass
    time.sleep(3)
    frame_cache.clear()
    def fresh():
      return host_count() == 1 and fs_wait('Step number', 3)
    ok = False
    try: ok = bool(wait_for(fresh, 15, 0.5))
    except AssertionError: pass
    check('extension reload: one fresh widget (the orphan is removed)', ok, {'hosts': host_count()})
  section('reload', reload)

  # ---- 12. Size of the content script ----
  size = os.path.getsize(os.path.join(DIST, 'content.js'))
  check('content.js stays small (< 64 KB, loaded only on run pages)', size < 64 * 1024, size)
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
