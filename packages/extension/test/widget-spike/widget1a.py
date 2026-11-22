#!/usr/bin/env python3
# Floating widget, phase 1a: a real headless Chrome check of the BUILT extension (packages/extension/dist) against a
# running stubyard (default http://127.0.0.1:41900, a throwaway one; see docs/design/floating-widget.md) and fixture
# app pages served here on 127.0.0.1:41811 (the run's app origin) and :41812 (another origin).
# Not part of npm test. Run:  python3 -I packages/extension/test/widget-spike/widget1a.py [OUT_DIR] [HUB_URL]
# Needs google-chrome >= 133. Screenshots and results.json go to OUT_DIR (default: a temp folder).
# What it checks: mount on the run's origin only (top frame), closed shadow root, nothing in the page DOM/text, the card
# at 390/768/1280/1920 px (bottom sheet under 480), light and dark, RTL default corner, drag + corner snap + saved place,
# Esc collapses (frame kept), tracked Done/Fail+note/Screenshot (captureClean: the widget is not in the shot), Next,
# live sync (a PATCH elsewhere moves the card), SPA route change keeps the tab URL live, back/forward cache restore,
# login shows Fill login (phase 1b), quick run Next / Finish with the hand-over when the run created users, "Hide on this
# tab", and the Settings switch.
import os, sys, json, time, threading, subprocess, http.server, socketserver, fcntl, traceback, tempfile, urllib.request, base64

WS = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.abspath(os.path.join(WS, '..', '..', 'dist'))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='stubyard-widget1a-')
HUB = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:41900'
os.makedirs(OUT, exist_ok=True)
APP = 'http://127.0.0.1:41811'
OTHER = 'http://127.0.0.1:41812'
CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; frame-src 'self'; connect-src 'self'"
FILLER = ''.join('<p>Paragraph %d of the app page. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>' % i for i in range(30))
FORM = '<form onsubmit="return false"><label>Full name <input name="name"></label><br><label>Email <input name="email" type="email"></label><br><button type="submit">Submit</button></form><p id="order">Order #A-1234 created</p>'
PAGES = {
  '/form': ('Sign up', FORM + FILLER, {}),
  '/csp': ('Strict CSP', FORM + FILLER, {'Content-Security-Policy': CSP}),
  '/spa/a': ('SPA', '<button id="go" onclick="history.pushState({}, \'\', \'/spa/b\'); document.title=\'SPA b\'">Go to route b</button>' + FILLER, {}),
  '/next': ('Next page', '<p>Another page</p>' + FILLER, {}),
  '/rtl': ('RTL', '<h1>صفحة التسجيل</h1>' + FORM + FILLER, {}),
  '/login': ('Login', '<form><input id="email"><input id="password" type="password"><button type="submit">Log in</button></form>', {}),
}
class App(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    path = self.path.split('?')[0]
    if path == '/spa/b': path = '/spa/a'
    if path not in PAGES: return self.send_error(404)
    title, body, headers = PAGES[path]
    rtl = path == '/rtl'
    html = '<!doctype html><html%s><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>%s</title></head><body style="font:15px/1.5 system-ui;margin:24px;background:#f4f6fb"><h2>%s</h2>%s</body></html>' % (' dir="rtl" lang="ar"' if rtl else '', title, title, body)
    b = html.encode()
    self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Cache-Control', 'no-store' if path == '/never' else 'max-age=0')
    for k, v in headers.items(): self.send_header(k, v)
    self.end_headers(); self.wfile.write(b)
class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
servers = []
for port in (41811, 41812):
  s = TS(('127.0.0.1', port), App); threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)

def api(method, path, body=None):
  req = urllib.request.Request(HUB + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
  with urllib.request.urlopen(req, timeout=10) as r:
    t = r.read().decode(); return json.loads(t) if t else None

# ---- seed stubyard ----
P = 'widget-qa-%d' % int(time.time())
api('POST', '/api/projects', {'name': 'Widget QA', 'slug': P, 'settings': {'appOrigins': [APP]}})
bundle = {
  'format': 'stubyard-storyboards', 'version': 1,
  'users': [{'email': 'ada@example.test', 'name': 'Ada Admin', 'role': 'admin', 'password': 'pw-123456'}],
  'loginRecipes': [{'role': 'admin', 'loginUrl': '/login', 'fields': {'username': '#email', 'password': '#password'}, 'twoFactor': {'kind': 'none'}}],
  'dataSets': [{'slug': 'signup', 'name': 'Sign-up', 'entries': [{'key': 'name', 'value': 'Ada Lovelace'}, {'key': 'email', 'value': 'ada@example.test'}]}],
  'storyboards': [
    {'slug': 'tracked', 'name': 'Widget QA tracked', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}], 'steps': [
      {'kind': 'open', 'title': 'Open route b', 'intent': 'Open the second route of the single-page app.', 'url': APP + '/spa/b'},
      {'kind': 'fill', 'title': 'Fill the sign-up form', 'intent': 'Fill the form with the sign-up data.', 'dataSet': 'signup', 'url': APP + '/form'},
      {'kind': 'capture', 'title': 'Capture the order number', 'intent': 'Read the order number shown after submit.', 'var': 'order', 'textPattern': 'Order #([A-Z0-9-]+)'},
      {'kind': 'check', 'title': 'The order shows', 'intent': 'Check the confirmation.', 'expect': 'The order number {{vars.order}} is shown', 'assert': {'textPresent': 'Order #'}},
      {'kind': 'instruction', 'title': 'انقر على زر الإرسال', 'intent': 'اضغط على الزر لإرسال النموذج.', 'target': {'selector': 'button[type=submit]'}},
      {'kind': 'login', 'title': 'Log in as Ada', 'intent': 'Log in with the admin user.', 'actor': 'ada'},
    ]},
    {'slug': 'quick', 'name': 'Widget QA quick', 'preferredMode': 'quick', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}], 'steps': [
      {'kind': 'open', 'title': 'Open the form', 'intent': 'Open the sign-up form.', 'url': APP + '/form'},
      {'kind': 'instruction', 'title': 'Look at the form', 'intent': 'Just look.'},
    ]},
    {'slug': 'fresh', 'name': 'Widget QA fresh user', 'preferredMode': 'quick', 'actors': [{'key': 'new', 'role': 'admin', 'fresh': True}], 'steps': [
      {'kind': 'instruction', 'title': 'Do something with a new user', 'intent': 'A run that created a user.'},
    ]},
  ],
}
api('POST', '/api/projects/%s/storyboards/import' % P, {'bundle': bundle})
def start(sb, mode='tracked'):
  return api('POST', '/api/projects/%s/walkthroughs' % P, {'storyboard': sb, 'origin': APP, 'mode': mode})
def getw(wid): return api('GET', '/api/projects/%s/walkthroughs/%s' % (P, wid))
W = start('tracked')

# ---- Chrome over a CDP pipe ----
r1, w1 = os.pipe(); r2, w2 = os.pipe()
def pre():
  a = fcntl.fcntl(r1, fcntl.F_DUPFD, 20); b = fcntl.fcntl(w2, fcntl.F_DUPFD, 20); os.dup2(a, 3); os.dup2(b, 4)
prof = tempfile.mkdtemp(prefix='stubyard-widget1a-prof-')
args = ['google-chrome', '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + prof,
        '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank']
proc = subprocess.Popen(args, preexec_fn=pre, close_fds=False, stdout=subprocess.DEVNULL, stderr=open(os.path.join(OUT, 'chrome.log'), 'w'))
os.close(r1); os.close(w2)
out = os.fdopen(w1, 'wb', buffering=0); inp = os.fdopen(r2, 'rb', buffering=0)
buf = b''; mid = 0
def send(method, params=None, session=None):
  global mid, buf
  mid += 1; i = mid; m = {'id': i, 'method': method, 'params': params or {}}
  if session: m['sessionId'] = session
  out.write(json.dumps(m).encode() + b'\0')
  while True:
    while b'\0' not in buf:
      c = inp.read(65536)
      if not c: raise EOFError('chrome closed')
      buf += c
    raw, buf = buf.split(b'\0', 1); msg = json.loads(raw)
    if msg.get('id') == i:
      if 'error' in msg: raise RuntimeError(method + ': ' + json.dumps(msg['error']))
      return msg.get('result', {})
def ev(session, expr):
  r = send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True}, session)
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
  print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else '  ' + json.dumps(detail)[:300]), flush=True)

try:
  ext = send('Extensions.loadUnpacked', {'path': DIST})['id']; R['extId'] = ext
  WIDGET = 'chrome-extension://%s/widget.html' % ext
  def attach(t):
    s = send('Target.attachToTarget', {'targetId': t, 'flatten': True})['sessionId']; send('Runtime.enable', {}, s); send('Page.enable', {}, s); return s
  # A controller page of the extension, in its own window (chrome.* calls).
  ct = send('Target.createTarget', {'url': 'chrome-extension://%s/sidepanel.html' % ext, 'newWindow': True})['targetId']; time.sleep(1); cs = attach(ct)
  def cx(expr): return ev(cs, expr)
  cx('chrome.storage.local.set({apiUrl: %s})' % json.dumps(HUB))
  # The app tab.
  pt = send('Target.createTarget', {'url': APP + '/form', 'newWindow': True})['targetId']; ps = attach(pt)
  time.sleep(1)
  tab = json.loads(cx('chrome.tabs.query({url: "%s/*"}).then(t => JSON.stringify({id: t[0].id, w: t[0].windowId}))' % APP))
  TID, WID = tab['id'], tab['w']
  def open_run(wid, origins=True):
    a = {'project': P, 'id': wid}
    if origins: a['origins'] = [APP]
    cx('chrome.storage.local.get("activeWalkthroughByWindow").then(r => chrome.storage.local.set({activeWalkthroughByWindow: {...(r.activeWalkthroughByWindow || {}), [%d]: %s}}))' % (WID, json.dumps(a)))
  def close_run():
    cx('chrome.storage.local.get("activeWalkthroughByWindow").then(r => { const m = {...(r.activeWalkthroughByWindow || {})}; delete m[%d]; return chrome.storage.local.set({activeWalkthroughByWindow: m}); })' % WID)
  def host_present(): return ev(ps, '!!document.querySelector("[data-stubyard-widget]")')
  def frame_session():
    for t in send('Target.getTargets')['targetInfos']:
      if t['type'] == 'iframe' and t['url'].startswith(WIDGET):
        return attach(t['targetId'])
    return None
  def fs_wait(text, timeout=10):
    def f():
      s = frame_session()
      if not s: return None
      body = ev(s, 'document.body.innerText')
      return s if text in (body or '') else None
    return wait_for(f, timeout)
  def click_btn(s, label):
    return ev(s, '(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === %s || b.getAttribute("aria-label") === %s); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "ok"; })()' % (json.dumps(label), json.dumps(label)))
  def shot(name, session=None):
    d = send('Page.captureScreenshot', {'format': 'png'}, session or ps)['data']
    p = os.path.join(OUT, name + '.png'); open(p, 'wb').write(base64.b64decode(d)); R['shots'].append(p); return p
  def metrics(w, h):
    send('Emulation.setDeviceMetricsOverride', {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': w < 480}, ps)
  def frame_h(s): return ev(s, 'innerHeight')

  # 1. No run: no widget.
  time.sleep(1)
  check('no run, no widget', not host_present())
  # 2. Open the run: the widget mounts on the app page.
  open_run(W['id'])
  wait_for(host_present)
  check('mounts on the run origin', True)
  page = json.loads(ev(ps, 'JSON.stringify({shadow: document.querySelector("[data-stubyard-widget]").shadowRoot, iframes: document.querySelectorAll("iframe").length, text: document.body.innerText.includes("Open route b"), parent: document.querySelector("[data-stubyard-widget]").parentElement.tagName, focus: document.activeElement.tagName})'))
  check('closed shadow root, nothing in the page DOM or text, focus untouched', page['shadow'] is None and page['iframes'] == 0 and not page['text'] and page['parent'] == 'HTML' and page['focus'] == 'BODY', page)
  fs = fs_wait('Open route b')
  check('widget shows the current step (hello + hub)', True)
  body = ev(fs, 'document.body.innerText')
  check('shows count, title, intent and Go', '1 / 6' in body and 'Open the second route' in body and 'Go' in body, body[:200])
  # 3. Widths, light.
  for (w, h) in ((390, 844), (768, 1024), (1280, 800), (1920, 1080)):
    metrics(w, h); time.sleep(0.8); shot('form-%d-light' % w)
  metrics(1280, 800); time.sleep(0.5)
  # 4. SPA route change: Go -> Reload on /spa/b.
  send('Page.navigate', {'url': APP + '/spa/a'}, ps); time.sleep(1.5)
  fs = fs_wait('Open route b')
  before = ev(fs, '[...document.querySelectorAll("button")].map(b => b.textContent.trim()).join("|")')
  ev(ps, 'document.getElementById("go").click()')
  def became_reload():
    s = frame_session(); return s and 'Reload' in ev(s, '[...document.querySelectorAll("button")].map(b => b.textContent.trim()).join("|")')
  ok = False
  try: ok = bool(wait_for(became_reload, 6))
  except AssertionError: pass
  check('SPA route change keeps the tab URL live (Go -> Reload)', ok and 'Go' in before, before)
  # 5. Tracked: Done moves on (step 2, fill). Fill form fills the page.
  fs = frame_session()
  click_btn(fs, 'Done')
  wait_for(lambda: getw(W['id'])['steps'][0]['status'] == 'done')
  fs = fs_wait('Fill the sign-up form')
  check('Done records the step and shows the next one', True)
  send('Page.navigate', {'url': APP + '/form'}, ps); time.sleep(1.5)
  fs = fs_wait('Fill the sign-up form')
  ev(fs, '[...document.querySelectorAll("summary")].forEach(s => s.click())')
  body = ev(fs, 'document.body.innerText')
  check('fill step shows its values', 'Ada Lovelace' in body, body[:300])
  shot('fill-1280-light')
  click_btn(fs, 'Fill form')
  filled = wait_for(lambda: ev(ps, 'document.querySelector("[name=name]").value') == 'Ada Lovelace', 6)
  check('Fill form fills the page from the widget (own tab)', filled)
  # 6. Live sync: another view (the panel, the dashboard) moves the run on; the widget follows.
  api('PATCH', '/api/projects/%s/walkthroughs/%s' % (P, W['id']), {'currentStepId': W['steps'][2]['id']})
  fs = fs_wait('Capture the order number', 6)
  check('live sync: a change elsewhere shows within seconds', True)
  click_btn(fs, 'Capture')
  time.sleep(1)
  val = ev(fs, '(document.querySelector(".controls input") || {}).value')
  check('Capture reads the page', val == 'A-1234', val)
  click_btn(fs, 'Save')
  wait_for(lambda: getw(W['id'])['vars'].get('order') == 'A-1234')
  check('Save stores the var in the hub', True)
  click_btn(fs, 'Done')
  fs = fs_wait('The order shows')
  body = ev(fs, 'document.body.innerText')
  check('check step shows the expectation with vars', 'A-1234' in body and 'Pass' in body, body[:300])
  # 7. Fail opens the note; Fail again records with the note.
  click_btn(fs, 'Fail')
  time.sleep(0.4)
  has_note = ev(fs, '!!document.querySelector("textarea")')
  ev(fs, '(() => { const t = document.querySelector("textarea"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, "Order number missing"); t.dispatchEvent(new Event("input", {bubbles: true})); })()')
  # 8. Screenshot via captureClean: the widget is hidden in the shot.
  shots0 = len(getw(W['id'])['steps'][3]['shots'])
  click_btn(fs, 'Screenshot')
  wait_for(lambda: len(getw(W['id'])['steps'][3]['shots']) > shots0, 8)
  st = getw(W['id'])['steps'][3]
  shot_id = st['shots'][-1]['id']
  img = urllib.request.urlopen(HUB + '/api/projects/%s/walkthroughs/%s/shots/%s' % (P, W['id'], shot_id)).read()
  open(os.path.join(OUT, 'stored-screenshot.jpg'), 'wb').write(img); R['shots'].append(os.path.join(OUT, 'stored-screenshot.jpg'))
  check('Screenshot stored from the widget (see stored-screenshot.jpg: no widget in it)', len(img) > 1000)
  click_btn(fs, 'Fail')
  wait_for(lambda: getw(W['id'])['steps'][3]['status'] == 'failed')
  check('Fail opens the note, then records failed with the note', has_note and getw(W['id'])['steps'][3]['note'] == 'Order number missing')
  # 9. Instruction (Arabic title, dir=auto) on the RTL page: default corner bottom-left.
  fs = fs_wait('انقر')
  send('Page.navigate', {'url': APP + '/rtl'}, ps); time.sleep(1.5)
  fs = fs_wait('انقر')
  d = ev(fs, 'document.querySelector(".w-title").getAttribute("dir")')
  check('storyboard text has dir=auto', d == 'auto', d)
  shot('rtl-1280-light')
  # The card's left edge: screenshot pixel check is fuzzy; read the frame's screen position through the page target.
  pos = ev(fs, 'JSON.stringify({x: window.screenX})')
  for (w, h) in ((390, 844), (1920, 1080)):
    metrics(w, h); time.sleep(0.8); shot('rtl-%d-light' % w)
  metrics(1280, 800)
  # 10. Dark mode.
  send('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'dark'}]}, ps)
  send('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'dark'}]}, fs)
  time.sleep(0.8)
  for (w, h) in ((390, 844), (768, 1024), (1280, 800), (1920, 1080)):
    metrics(w, h); time.sleep(0.8)
    s2 = frame_session()
    if s2: send('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'dark'}]}, s2)
    time.sleep(0.4); shot('rtl-%d-dark' % w)
  send('Emulation.setEmulatedMedia', {'features': []}, ps)
  metrics(1280, 800)
  # 11. Login: runs in the widget since phase 1b (widget1b.py covers it in depth).
  fs = frame_session(); click_btn(fs, 'Done')
  fs = fs_wait('Log in as Ada')
  body = ev(fs, 'document.body.innerText')
  check('login step runs in the widget (Fill login, no Continue in panel)', 'Fill login' in body and 'Continue in panel' not in body, body[:200])
  shot('login-1280-light')
  # 12. Drag + snap + saved place (back on the LTR form page).
  send('Page.navigate', {'url': APP + '/form'}, ps); time.sleep(1.5)
  fs = fs_wait('Log in as Ada')
  time.sleep(0.5)
  fh = frame_h(fs); vw, vh = 1280, 800
  card_h = fh + 20
  hx, hy = vw - 16 - 170, vh - 16 - card_h + 9
  def mouse(t, x, y, buttons=1):
    send('Input.dispatchMouseEvent', {'type': t, 'x': x, 'y': y, 'button': 'left', 'buttons': buttons, 'clickCount': 1}, ps)
  mouse('mouseMoved', hx, hy, 0); mouse('mousePressed', hx, hy)
  for i in range(1, 11):
    mouse('mouseMoved', hx + (200 - hx) * i / 10, hy + (80 - hy) * i / 10)
  mouse('mouseReleased', 200, 80, 0)
  time.sleep(0.6)
  saved = json.loads(cx('chrome.storage.local.get("widgetPlacementByOrigin").then(r => JSON.stringify(r.widgetPlacementByOrigin || {}))'))
  pl = saved.get(APP, {})
  check('drag snaps to the top-left corner and saves the place per origin', pl.get('corner') == 'top-left', pl)
  shot('dragged-top-left-1280')
  send('Page.reload', {}, ps); time.sleep(2)
  fs_wait('Log in as Ada')
  shot('dragged-after-reload-1280')
  # 13. Esc collapses to the pill; the frame stays loaded.
  fs = frame_session()
  ev(fs, 'document.querySelector("button").focus()')
  send('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27}, fs)
  send('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27}, fs)
  time.sleep(0.6)
  still = frame_session() is not None
  saved = json.loads(cx('chrome.storage.local.get("widgetPlacementByOrigin").then(r => JSON.stringify(r.widgetPlacementByOrigin || {}))'))
  check('Esc collapses to the pill, the frame stays loaded', still and saved.get(APP, {}).get('collapsed') is True, saved.get(APP))
  shot('collapsed-pill-1280')
  # Reset the place and expand for the next checks.
  cx('chrome.storage.local.remove("widgetPlacementByOrigin")')
  send('Page.reload', {}, ps); time.sleep(2)
  # 14. bfcache: go to another page and back.
  fs_wait('Log in as Ada')
  send('Page.navigate', {'url': APP + '/next'}, ps); time.sleep(1.5)
  ev(ps, 'history.back()'); time.sleep(2)
  restored = ev(ps, 'performance.getEntriesByType("navigation")[0].type')
  ok = False
  try: ok = bool(fs_wait('Log in as Ada', 8))
  except AssertionError: pass
  check('back/forward: the widget works after coming back', ok and host_present(), {'navType': restored})
  # 15. Other origin and frames: no widget.
  send('Page.navigate', {'url': OTHER + '/form'}, ps); time.sleep(2)
  check('no widget on another origin', not host_present())
  send('Page.navigate', {'url': APP + '/csp'}, ps); time.sleep(1.5)
  ok = False
  try: ok = bool(fs_wait('Log in as Ada', 8))
  except AssertionError: pass
  check('works on a strict-CSP page', ok)
  # 16. Hide on this tab.
  fs = frame_session(); click_btn(fs, 'Hide on this tab')
  wait_for(lambda: not host_present(), 6)
  ov = json.loads(cx('chrome.storage.session.get("widgetTabOverride").then(r => JSON.stringify(r.widgetTabOverride || {}))'))
  check('Hide on this tab removes it and remembers the tab', ov.get(str(TID)) == 'hide', ov)
  cx('chrome.storage.session.set({widgetTabOverride: {}})')
  wait_for(host_present, 6)
  # 17. Settings switch off / on.
  cx('chrome.storage.local.set({widgetEnabled: false})'); wait_for(lambda: not host_present(), 6)
  check('the Settings switch removes it', True)
  cx('chrome.storage.local.set({widgetEnabled: true})'); wait_for(host_present, 6)
  # 18. Quick run: action buttons, Next ✓, Finish closes the run.
  Q = start('quick', 'quick'); open_run(Q['id'])
  send('Page.navigate', {'url': APP + '/form'}, ps); time.sleep(1.5)
  fs = fs_wait('Open the form')
  body = ev(fs, 'document.body.innerText')
  check('quick run: Quick chip, Next and Finish, no Done/Skip/Fail', 'Quick' in body and 'Next ✓' in body and 'Finish' in body and 'Skip' not in body, body[:200])
  shot('quick-1280-light')
  metrics(390, 844); time.sleep(0.8); shot('quick-390-light'); metrics(1280, 800)
  click_btn(fs, 'Next ✓'); fs = fs_wait('Look at the form')
  click_btn(fs, 'Finish')
  wait_for(lambda: getw(Q['id'])['status'] == 'finished')
  wait_for(lambda: not host_present(), 6)
  check('quick Finish ends the run and the widget leaves', True)
  # 19. Quick run that created a user: Finish hands over to the panel's cleanup.
  F = start('fresh', 'quick'); open_run(F['id'])
  fs = fs_wait('Do something with a new user')
  click_btn(fs, 'Finish')
  fs = fs_wait('Clean it up in the panel')
  body = ev(fs, 'document.body.innerText')
  check('quick Finish with a created user: hand-over to the panel cleanup', 'Open panel' in body and 'Close' not in body, body[:200])
  shot('quick-cleanup-handover-1280')
  # 20. A run opened without origins shows nowhere until the panel fills them in.
  close_run(); wait_for(lambda: not host_present(), 6)
  open_run(start('quick', 'quick')['id'], origins=False); time.sleep(2)
  check('a run without stored origins shows no widget', not host_present())
except Exception:
  R['error'] = traceback.format_exc(); print(R['error'], flush=True)
finally:
  try: send('Browser.close')
  except Exception: pass
  time.sleep(0.5); proc.kill()
  for s in servers: s.shutdown()
json.dump(R, open(os.path.join(OUT, 'results.json'), 'w'), indent=1)
fails = [k for k, v in R['checks'].items() if not v['ok']]
print('%d checks, %d failed%s' % (len(R['checks']), len(fails), (': ' + ', '.join(fails)) if fails else ''))
print(OUT)
sys.exit(1 if fails or 'error' in R else 0)
