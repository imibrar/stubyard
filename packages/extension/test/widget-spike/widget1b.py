#!/usr/bin/env python3
# Floating widget, phase 1b: a real headless Chrome check of the BUILT extension (packages/extension/dist) against a
# running throwaway stubyard (default http://127.0.0.1:41900, SMTP on 127.0.0.1:41925) and fixture app pages served
# here on 127.0.0.1:41811. Not part of npm test. Run:
#   python3 -I packages/extension/test/widget-spike/widget1b.py [OUT_DIR] [HUB_URL] [SMTP_PORT]
# Needs google-chrome >= 133. Screenshots and results.json go to OUT_DIR (default: a temp folder).
# What it checks, with the side panel open in the same window (so "never both" is real):
#  - login in the widget: compact creds, copy (clipboard chain), Fill login stores step.data.twoFactorPending, then the
#    tester clicks Log in, the page NAVIGATES to /2fa, the new widget resumes the wait and fills the TOTP code once
#    (the code field appears late); the panel says "Waiting … in the page widget" and never fills;
#  - email: Wait in the widget (the panel says where it waits), collapse (Esc) while waiting, the email arrives over
#    SMTP, the wait finished while collapsed (busy pill), the compact picker shows 5 of 8 links + "more in the panel",
#    a picked link opens in the tab;
#  - shortcuts: Alt+Shift+F fills once (the widget takes it, the panel does not fill too), Alt+Shift+W collapses /
#    expands, and shows the widget again on a tab where it was hidden. Headless Chrome cannot press extension
#    shortcuts, so the harness calls the worker's command handler (self.__stubyardCommand) instead.
import os, sys, json, time, threading, subprocess, http.server, socketserver, fcntl, traceback, tempfile, urllib.request, base64

WS = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.abspath(os.path.join(WS, '..', '..', 'dist'))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='stubyard-widget1b-')
HUB = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:41900'
SMTP_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 41925
os.makedirs(OUT, exist_ok=True)
APP = 'http://127.0.0.1:41811'
OTHER = 'http://127.0.0.1:41812'
CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; frame-src 'self'; connect-src 'self'"
FILLER = ''.join('<p>Paragraph %d of the app page. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>' % i for i in range(30))
FORM = '<form onsubmit="return false"><label>Full name <input name="name"></label><br><label>Email <input name="email" type="email"></label><br><button type="submit">Submit</button></form><p id="order">Order #A-1234 created</p>'
CODE_PAGE = ('<div id="slot">Checking your password…</div><script>window.__codeChanges = 0; setTimeout(() => { document.getElementById("slot").innerHTML = \'<label>Code <input id="code" autocomplete="one-time-code"></label> <button>Verify</button>\'; document.getElementById("code").addEventListener("change", () => window.__codeChanges++); }, 1500);</script>')
COUNT = '<script>window.__changes = {}; document.addEventListener("change", (e) => { const k = e.target.name || e.target.id; window.__changes[k] = (window.__changes[k] || 0) + 1; }, true);</script>'
PAGES = {
  '/form': ('Sign up', FORM + COUNT + FILLER, {}),
  '/login': ('Login', '<form action="/2fa" method="get"><label>Email <input id="email" name="email"></label><br><label>Password <input id="password" name="password" type="password"></label><br><button type="submit">Log in</button></form>' + COUNT, {}),
  '/2fa': ('Two-factor check', CODE_PAGE, {}),
  '/welcome': ('Welcome', '<p>Confirmed.</p>', {}),
  '/next': ('Next page', '<p>Another page</p>' + FILLER, {}),
}
for i in range(1, 9): PAGES['/l/%d' % i] = ('Link %d' % i, '<p>Link page %d</p>' % i, {})
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
for port in (41811,):
  s = TS(('127.0.0.1', port), App); threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)

def api(method, path, body=None):
  req = urllib.request.Request(HUB + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json'})
  with urllib.request.urlopen(req, timeout=10) as r:
    t = r.read().decode(); return json.loads(t) if t else None


import smtplib, select
from email.mime.text import MIMEText

# ---- seed stubyard ----
P = 'widget-1b-%d' % int(time.time())
api('POST', '/api/projects', {'name': 'Widget 1b QA', 'slug': P, 'settings': {'appOrigins': [APP]}})
SECRET = 'JBSWY3DPEHPK3PXP'
api('POST', '/api/projects/%s/authenticators' % P, {'label': 'Ada 2FA', 'secret': SECRET})
bundle = {
  'format': 'stubyard-storyboards', 'version': 1,
  'users': [{'email': 'ada@example.test', 'name': 'Ada Admin', 'role': 'admin', 'password': 'pw-123456'}],
  'loginRecipes': [{'role': 'admin', 'loginUrl': '/login', 'fields': {'username': '#email', 'password': '#password'}, 'twoFactor': {'kind': 'totp', 'selector': '#code', 'authenticator': 'Ada 2FA'}}],
  'dataSets': [{'slug': 'signup', 'name': 'Sign-up', 'entries': [{'key': 'name', 'value': 'Ada Lovelace'}, {'key': 'email', 'value': 'ada@example.test'}]}],
  'storyboards': [
    {'slug': 'b1', 'name': 'Widget 1b', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}], 'steps': [
      {'kind': 'login', 'title': 'Log in as Ada (2FA)', 'intent': 'Log in with the admin user and the authenticator code.', 'actor': 'ada'},
      {'kind': 'email', 'title': 'Open the welcome email', 'intent': 'Pick the confirmation link.', 'actor': 'ada', 'match': {'subject': 'Welcome'}, 'timeoutSec': 120},
      {'kind': 'fill', 'title': 'Fill the sign-up form', 'intent': 'Fill the form with the sign-up data.', 'dataSet': 'signup', 'url': APP + '/form'},
      {'kind': 'instruction', 'title': 'Look around', 'intent': 'Nothing to fill here.'},
    ]},
  ],
}
api('POST', '/api/projects/%s/storyboards/import' % P, {'bundle': bundle})
W = api('POST', '/api/projects/%s/walkthroughs' % P, {'storyboard': 'b1', 'origin': APP, 'mode': 'tracked'})
def getw(wid): return api('GET', '/api/projects/%s/walkthroughs/%s' % (P, wid))
def step_data(i): return getw(W['id'])['steps'][i]['data']
def totp_now(): return api('GET', '/api/projects/%s/authenticators/code?label=Ada%%202FA' % P)['code']
def send_email(links):
  body = 'Welcome to the app. Confirm your address:\n' + '\n'.join(links) + '\n'
  m = MIMEText(body); m['Subject'] = 'Welcome to the app'; m['From'] = 'app@example.test'; m['To'] = 'ada@example.test'
  with smtplib.SMTP('127.0.0.1', SMTP_PORT, timeout=10) as s:
    try: s.login(P, 'x')
    except smtplib.SMTPException: pass
    s.sendmail('app@example.test', ['ada@example.test'], m.as_string())

# ---- Chrome over a CDP pipe ----
r1, w1 = os.pipe(); r2, w2 = os.pipe()
def pre():
  a = fcntl.fcntl(r1, fcntl.F_DUPFD, 20); b = fcntl.fcntl(w2, fcntl.F_DUPFD, 20); os.dup2(a, 3); os.dup2(b, 4)
prof = tempfile.mkdtemp(prefix='stubyard-widget1b-prof-')
args = ['google-chrome', '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + prof,
        '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank']
proc = subprocess.Popen(args, preexec_fn=pre, close_fds=False, stdout=subprocess.DEVNULL, stderr=open(os.path.join(OUT, 'chrome.log'), 'w'))
os.close(r1); os.close(w2)
out = os.fdopen(w1, 'wb', buffering=0); inp = os.fdopen(r2, 'rb', buffering=0)
buf = b''; mid = 0
def send(method, params=None, session=None, timeout=20):
  # With a deadline: a command to a frame that is going away (a navigation) may never be answered.
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
  print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else '  ' + json.dumps(detail)[:300]), flush=True)


try:
  ext = send('Extensions.loadUnpacked', {'path': DIST})['id']; R['extId'] = ext
  WIDGET = 'chrome-extension://%s/widget.html' % ext
  PANEL = 'chrome-extension://%s/sidepanel.html' % ext
  def attach(t):
    s = send('Target.attachToTarget', {'targetId': t, 'flatten': True})['sessionId']; send('Runtime.enable', {}, s); send('Page.enable', {}, s); return s
  ct = send('Target.createTarget', {'url': PANEL, 'newWindow': True})['targetId']; time.sleep(1); cs = attach(ct)
  def cx(expr): return ev(cs, expr)
  cx('chrome.storage.local.set({apiUrl: %s, widgetHintSeen: true})' % json.dumps(HUB))
  pt = send('Target.createTarget', {'url': APP + '/login', 'newWindow': True})['targetId']; ps = attach(pt)
  time.sleep(1)
  tab = json.loads(cx('chrome.tabs.query({url: "%s/*"}).then(t => JSON.stringify({id: t[0].id, w: t[0].windowId}))' % APP))
  TID, WID = tab['id'], tab['w']
  a = {'project': P, 'id': W['id'], 'origins': [APP]}
  cx('chrome.storage.local.get("activeWalkthroughByWindow").then(r => chrome.storage.local.set({activeWalkthroughByWindow: {...(r.activeWalkthroughByWindow || {}), [%d]: %s}}))' % (WID, json.dumps(a)))
  # The side panel, open in the SAME window (a background tab: its active tab stays the app tab).
  cx('chrome.tabs.create({windowId: %d, url: %s, active: false})' % (WID, json.dumps(PANEL)))
  time.sleep(1.5)
  def panel_session():
    for t in send('Target.getTargets')['targetInfos']:
      if t['type'] == 'page' and t['url'].startswith(PANEL) and t['targetId'] != ct:
        return attach(t['targetId'])
  pn = panel_session()
  def panel_text(): return ev(pn, 'document.body.innerText') or ''
  def sw_session():
    for t in send('Target.getTargets')['targetInfos']:
      if t['type'] == 'service_worker' and t['url'].startswith('chrome-extension://%s/' % ext):
        return send('Target.attachToTarget', {'targetId': t['targetId'], 'flatten': True})['sessionId']
  def command(name):
    s = sw_session(); return ev(s, 'self.__stubyardCommand(%s)' % json.dumps(name))
  def host_present(): return ev(ps, '!!document.querySelector("[data-stubyard-widget]")')
  frame_cache = {}
  def frame_sessions():
    # Every widget frame target, newest last, each attached once (a frame of a page that just navigated away may
    # linger for a moment; attaching again on every poll piles up sessions and slows Chrome down).
    out = []
    for t in send('Target.getTargets')['targetInfos']:
      if t['type'] == 'iframe' and t['url'].startswith(WIDGET):
        tid = t['targetId']
        if tid not in frame_cache:
          try: frame_cache[tid] = attach(tid)
          except (TimeoutError, RuntimeError): continue
        out.append(frame_cache[tid])
    return out
  def frame_session():
    for s in reversed(frame_sessions()):
      try:
        if ev(s, 'document.readyState') == 'complete': return s
      except (TimeoutError, RuntimeError): continue
    return None
  def fs_wait(text, timeout=12):
    seen = {}
    def f():
      for s in reversed(frame_sessions()):
        try: body = ev(s, 'document.body.innerText')
        except (TimeoutError, RuntimeError): continue
        seen['body'] = body
        if text in (body or ''): return s
      return None
    try: return wait_for(f, timeout)
    except AssertionError:
      try:
        shot('debug-%s' % ''.join(c for c in text if c.isalnum()))
        R['debugTargets'] = [(t['type'], t['url'][:90]) for t in send('Target.getTargets')['targetInfos']]
        R['debugPage'] = ev(ps, 'location.href')
      except Exception: pass
      raise AssertionError('no %r in the widget; host: %r; last text: %r' % (text, host_present(), (seen.get('body') or '')[:400]))
  def click_btn(s, label):
    return ev(s, '(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === %s || b.getAttribute("aria-label") === %s); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "ok"; })()' % (json.dumps(label), json.dumps(label)))
  def real_click(s, label):
    # A real mouse click inside the frame (a user gesture, so the async clipboard may work).
    box = json.loads(ev(s, '(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === %s || b.getAttribute("aria-label") === %s); const r = b.getBoundingClientRect(); return JSON.stringify({x: r.x + r.width / 2, y: r.y + r.height / 2}); })()' % (json.dumps(label), json.dumps(label))))
    for t in ('mousePressed', 'mouseReleased'):
      send('Input.dispatchMouseEvent', {'type': t, 'x': box['x'], 'y': box['y'], 'button': 'left', 'buttons': 1 if t == 'mousePressed' else 0, 'clickCount': 1}, s)
  def shot(name):
    d = send('Page.captureScreenshot', {'format': 'png'}, ps)['data']
    p = os.path.join(OUT, name + '.png'); open(p, 'wb').write(base64.b64decode(d)); R['shots'].append(p); return p
  def metrics(w, h):
    send('Emulation.setDeviceMetricsOverride', {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': w < 480}, ps)
  def press(label, timeout=10):
    # Click a widget button once it is there and enabled (the step resolves after its title shows).
    def f():
      for s in reversed(frame_sessions()):
        try:
          if click_btn(s, label) == 'ok': return True
        except (TimeoutError, RuntimeError): continue
      return False
    return wait_for(f, timeout)
  def done_step(i, title):
    # Done in the widget; retried, because the frame may be replaced by a navigation right then.
    for _ in range(3):
      try:
        s = fs_wait(title); click_btn(s, 'Done')
        wait_for(lambda: getw(W['id'])['steps'][i]['status'] == 'done', 5)
        return True
      except (AssertionError, TimeoutError, RuntimeError):
        time.sleep(1)
    raise AssertionError('Done of step %d did not register' % i)
  def placement(): return json.loads(cx('chrome.storage.local.get("widgetPlacementByOrigin").then(r => JSON.stringify((r.widgetPlacementByOrigin || {})[%s] || {}))' % json.dumps(APP)))

  # ---- 1. Login + TOTP across a navigation ----
  wait_for(host_present, 10)
  fs = fs_wait('Fill login')
  body = ev(fs, 'document.body.innerText')
  check('login runs in the widget (no Continue in panel): compact creds and Fill login', 'Continue in panel' not in body and 'Fill login' in body and 'ada@example.test' in body and 'Ada 2FA' in body, body[:300])
  for (w, h) in ((390, 844), (768, 1024), (1280, 800), (1920, 1080)):
    metrics(w, h); time.sleep(0.8); shot('login-%d' % w)
  metrics(1280, 800); time.sleep(0.5)
  fs = frame_session()
  real_click(fs, 'Copy the username'); time.sleep(0.5)
  copied = ev(fs, 'document.body.innerText')
  check('copy: "copied" (clipboard) or the select-and-copy fallback', 'copied' in copied or 'Select the text and copy it' in copied, copied[:200])
  press('Fill login')
  wait_for(lambda: ev(ps, 'document.getElementById("password").value') == 'pw-123456', 6)
  pend = step_data(0).get('twoFactorPending')
  check('Fill login fills the page and stores step.data.twoFactorPending (owner widget, this tab)', bool(pend) and pend.get('owner') == 'widget' and pend.get('tabId') == TID, pend)
  time.sleep(1.5)
  pt_text = panel_text()
  check('the panel says the 2FA wait runs in the page widget (it does not wait too)', 'Waiting for the 2FA code in the page widget' in pt_text, pt_text[-400:])
  shot('login-filled-1280')
  # The tester clicks Log in: a real navigation to /2fa (the old widget frame is gone).
  codes = [totp_now()]
  ev(ps, 'document.querySelector("button[type=submit]").click()')
  wait_for(lambda: ev(ps, 'location.pathname') == '/2fa', 6)
  time.sleep(0.3)
  shot('2fa-waiting-1280')
  filled = wait_for(lambda: ev(ps, '(document.getElementById("code") || {}).value || ""'), 20)
  codes.append(totp_now())
  check('the widget on the next page resumes the wait and fills the TOTP code', filled in codes, {'filled': filled, 'codes': codes})
  wait_for(lambda: step_data(0).get('twoFactorFilled') is True, 6)
  d0 = step_data(0)
  check('step data: twoFactorFilled, the pending wait cleared', d0.get('twoFactorFilled') is True and d0.get('twoFactorPending') is None, d0)
  time.sleep(4)  # long enough for a second fill to show up, if there were one
  n = ev(ps, 'window.__codeChanges')
  check('the code was filled once (the panel did not fill as well)', n == 1, n)
  shot('2fa-filled-1280')
  done_step(0, 'Log in as Ada')
  # ---- 2. Email: wait in the widget, collapse while waiting, compact picker ----
  fs_wait('Open the welcome email')
  press('Wait for message')
  wait_for(lambda: (step_data(1).get('emailWaitPending') or {}).get('owner') == 'widget', 6)
  time.sleep(1.5)
  pt_text = panel_text()
  check('email wait in the widget; the panel says where it waits', 'Waiting for the email in the page widget' in pt_text, pt_text[-300:])
  fs = frame_session()
  ev(fs, 'document.querySelector("button").focus()')
  send('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27}, fs)
  send('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27}, fs)
  time.sleep(0.6)
  check('Esc collapses while waiting', placement().get('collapsed') is True, placement())
  shot('email-waiting-collapsed-1280')
  links = [APP + '/l/%d' % i for i in range(1, 9)]
  send_email(links)
  wait_for(lambda: step_data(1).get('messageId'), 20)
  d1 = step_data(1)
  check('the wait kept running while collapsed: message found, pending cleared', bool(d1.get('messageId')) and d1.get('emailWaitPending') is None, d1)
  command('toggle-widget'); time.sleep(0.8)
  check('Alt+Shift+W expands the widget', placement().get('collapsed') is False, placement())
  fs = fs_wait('more link')
  info = json.loads(ev(fs, 'JSON.stringify({radios: document.querySelectorAll("input[type=radio]").length, text: document.body.innerText})'))
  check('compact picker: 5 links, then "3 more links in the panel"', info['radios'] == 5 and '3 more links in the panel' in info['text'], info)
  for (w, h) in ((390, 844), (1280, 800)):
    metrics(w, h); time.sleep(0.8); shot('email-picker-%d' % w)
  metrics(1280, 800); time.sleep(0.5)
  fs = frame_session()
  ev(fs, 'document.querySelectorAll("input[type=radio]")[2].click()')
  time.sleep(0.2)
  press('Open link')
  wait_for(lambda: ev(ps, 'location.pathname') == '/l/3', 8)
  wait_for(lambda: step_data(1).get('link') == APP + '/l/3', 6)
  check('the picked link opens in the tab and is stored', True)
  time.sleep(1)
  done_step(1, 'Open the welcome email')
  # ---- 3. Shortcuts ----
  send('Page.navigate', {'url': APP + '/form'}, ps)
  fs_wait('Fill form')
  time.sleep(1)
  r = command('fill-form')
  wait_for(lambda: ev(ps, 'document.querySelector("[name=name]").value') == 'Ada Lovelace', 6)
  time.sleep(2.5)
  ch = json.loads(ev(ps, 'JSON.stringify(window.__changes)'))
  check('Alt+Shift+F: the widget fills, once (the panel does not fill too)', r == 'widget' and ch.get('name') == 1 and ch.get('email') == 1, {'route': r, 'changes': ch})
  shot('shortcut-filled-1280')
  done_step(2, 'Fill the sign-up form')
  fs = fs_wait('Look around')
  r = command('fill-form')
  check('Alt+Shift+F on a step without a fill goes to the panel', r == 'panel', r)
  r1 = command('toggle-widget'); time.sleep(0.6); c1 = placement().get('collapsed')
  r2 = command('toggle-widget'); time.sleep(0.6); c2 = placement().get('collapsed')
  check('Alt+Shift+W collapses, then expands', r1 == 'toggled' and c1 is True and r2 == 'toggled' and c2 is False, [r1, c1, r2, c2])
  press('Hide on this tab')
  wait_for(lambda: not host_present(), 6)
  r3 = command('toggle-widget')
  ok = False
  try: ok = bool(fs_wait('Look around', 8))
  except AssertionError: pass
  ov = json.loads(cx('chrome.storage.session.get("widgetTabOverride").then(r => JSON.stringify(r.widgetTabOverride || {}))'))
  check('Alt+Shift+W shows a hidden widget again on this tab', r3 == 'shown' and ok and ov.get(str(TID)) == 'show', {'r': r3, 'ov': ov})
  shot('shown-again-1280')
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
