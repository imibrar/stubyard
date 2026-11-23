#!/usr/bin/env python3
# Walkthrough recording R2 (video mode): a real headless Chrome check of the BUILT test extension (dist-test/,
# npm run build:test) against a running throwaway stubyard (default http://127.0.0.1:48200) whose dashboard is
# built (web/dist), with fixture app pages served here on 127.0.0.1:48211 (the run's origin) and 127.0.0.1:48212
# (another origin). Not part of npm test. Build first:
#   ./scripts/npm.sh run build && ./scripts/npm.sh run build:test -w @stubyard/extension
#   python3 -I packages/extension/test/widget-spike/recording2.py [OUT_DIR] [HUB_URL]
# A throwaway hub on 48200 (stop it after: docker stop stubyard-rec-r2):
#   STUBYARD_DOCKER_ARGS="-p 127.0.0.1:48200:4000 -e STUBYARD_HOST=0.0.0.0 -e STUBYARD_DATA_DIR=/tmp/rec-r2 \
#     --name stubyard-rec-r2" ./scripts/npm.sh exec -w server -- tsx src/index.ts
# SHOTS_DIR=<dir> puts the dashboard screenshots there (default OUT_DIR).
#
# Headless Chrome only allows tab capture for an extension named by --allowlisted-extension-id (a real Chrome asks
# for a click on the extension instead: activeTab). The id of an unpacked extension is derived from its path, so it
# is computed here before Chrome starts. Do not add --use-fake-ui-for-media-stream or --auto-accept-this-tab-capture:
# with them the capture fails (NotFoundError).
# What it checks:
#  - a storyboard with record: video warns at start; Record video (the video.start message) captures the tab;
#  - the widget folds to its pill while video is on; the extension's own password / code fills show dots;
#  - the capture goes on across page loads (one video segment), pauses on another origin, step changes made on the
#    hub become step markers; chunks every ~5 s; the tab closing finishes the video (final chunk, complete);
#  - the hub serves video/webm with Range (206, 416), a Duration in the file; the dashboard plays it in a <video>:
#    duration, a marker seeks there, 2x speed; a frame grabbed after the fills;
#  - sizes: MB per minute of a form page with typing and of a page that animates all the time;
#  - a 1920 px wide window is captured at 1280 px; a small cap (recordingMaxMb) stops the video cleanly near it;
#  - dashboard screenshots at 390 / 768 / 1280 / 1920 px (dark) and 390 / 1280 px (light).
import os, sys, json, time, threading, subprocess, http.server, socketserver, fcntl, traceback, tempfile, urllib.request, base64, select, gzip, hashlib

WS = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.abspath(os.path.join(WS, '..', '..', 'dist-test'))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='stubyard-recording2-')
HUB = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:48200'
os.makedirs(OUT, exist_ok=True)
SHOTS = os.environ.get('SHOTS_DIR') or OUT
os.makedirs(SHOTS, exist_ok=True)
APP = 'http://127.0.0.1:48211'
OTHER = 'http://127.0.0.1:48212'
SECRET_PW = 'hunter2-Sekr3t!'
SECRET_OTP = '493817'
FILLER = ''.join('<p>Paragraph %d of the app page. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>' % i for i in range(30))
STYLE = '<style>body{font:15px/1.5 system-ui;margin:24px;background:#f4f6fb;color:#1c2333} .card{background:#fff;border:1px solid #dde3ee;border-radius:10px;padding:16px;margin:12px 0;max-width:560px} input{display:block;margin:4px 0 12px;padding:8px;width:100%;box-sizing:border-box;font-size:18px} button{padding:8px 16px} li{padding:6px 0;border-bottom:1px solid #eee}</style>'
FORM = ('<div class="card"><form onsubmit="return false"><label>Email <input id="email" name="email" type="email"></label>'
        '<label>Password <input id="pw" name="password" type="text"></label>'
        '<label>Verification code <input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label>'
        '<label>Full name <input id="name" name="fullname"></label><button type="submit">Sign in</button></form></div>')
LIST = ('<div class="card"><button id="add" onclick="const li=document.createElement(\'li\');li.textContent=\'Order #\'+(document.querySelectorAll(\'#orders li\').length+1)+\' created at \'+new Date().toLocaleTimeString();document.getElementById(\'orders\').append(li)">Add order</button>'
        '<ul id="orders"></ul><label>Search <input id="q" name="q"></label></div>')
ANIM = ('<style>.b{position:absolute;width:120px;height:120px;border-radius:20px;animation:m 2.3s linear infinite alternate}@keyframes m{from{transform:translate(0,0) rotate(0)}to{transform:translate(900px,420px) rotate(360deg)}}</style>'
        '<h1 id="t" style="font-size:64px">0</h1><script>setInterval(()=>{t.textContent=Date.now()+" "+Math.random().toString(36).slice(2)},50)</script>'
        + ''.join('<div class="b" style="background:hsl(%d,70%%,55%%);left:%dpx;top:%dpx;animation-delay:-%ss"></div>' % (i * 37, 20 + i * 40, 120 + (i * 53) % 300, i * 0.3) for i in range(12)))
PAGES = {'/form': ('Sign in', FORM + FILLER), '/next': ('Orders', LIST + FILLER), '/anim': ('Busy page', ANIM)}
class App(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    path = self.path.split('?')[0]
    if path not in PAGES: return self.send_error(404)
    title, body = PAGES[path]
    b = ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>%s</title>%s</head><body><h2>%s</h2>%s</body></html>' % (title, STYLE, title, body)).encode()
    self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(b)
class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
servers = []
for port in (48211, 48212):
  s = TS(('127.0.0.1', port), App); threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)

def http_req(method, path, body=None, headers=None):
  h = {'content-type': 'application/json', **(headers or {})}
  req = urllib.request.Request(HUB + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
  try:
    with urllib.request.urlopen(req, timeout=20) as r:
      data = r.read()
      if r.headers.get('content-encoding') == 'gzip': data = gzip.decompress(data)
      return r.status, dict(r.headers), data
  except urllib.error.HTTPError as e:
    return e.code, dict(e.headers), e.read()
def api(method, path, body=None):
  st, _, data = http_req(method, path, body)
  if st >= 400: raise RuntimeError('%s %s: %s %s' % (method, path, st, data.decode()[:600]))
  t = data.decode(); return json.loads(t) if t else None

def make_project(slug, settings):
  api('POST', '/api/projects', {'name': 'Video QA ' + slug, 'slug': slug, 'settings': settings})
  bundle = {
    'format': 'stubyard-storyboards', 'version': 1,
    'users': [{'email': 'ada@example.test', 'name': 'Ada Admin', 'role': 'admin', 'password': 'pw-123456'}],
    'storyboards': [{'slug': 'video', 'name': 'Video walkthrough', 'record': 'video', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}],
                     'steps': [{'kind': 'instruction', 'title': t, 'intent': i} for t, i in STEPS]}],
  }
  api('POST', '/api/projects/%s/storyboards/import' % slug, {'bundle': bundle})
  return api('POST', '/api/projects/%s/walkthroughs' % slug, {'storyboard': 'video', 'origin': APP, 'mode': 'tracked'})
STEPS = [('Sign in with the test account', 'The extension fills the password and the code.'), ('Check the order list', 'Add two orders.'), ('Search an order', 'Search for order 2.')]
T0 = int(time.time())
P = 'video-qa-%d' % T0
W = make_project(P, {'appOrigins': [APP]})
WID = W['id']; SIDS = [s['id'] for s in W['steps']]
def rec(p=None, wid=None): return api('GET', '/api/projects/%s/walkthroughs/%s/recording' % (p or P, wid or WID))
def set_step(i): api('PATCH', '/api/projects/%s/walkthroughs/%s' % (P, WID), {'currentStepId': SIDS[i]})
def seg_path(no, p=None, wid=None): return '/api/projects/%s/walkthroughs/%s/recording/segments/%d' % (p or P, wid or WID, no)

# The id Chrome gives an unpacked extension: sha256 of its path, the first 32 hex digits as a-p.
EXT_ID = ''.join(chr(ord('a') + int(c, 16)) for c in hashlib.sha256(DIST.encode()).hexdigest()[:32])

# ---- Chrome over a CDP pipe ----
r1, w1 = os.pipe(); r2, w2 = os.pipe()
def pre():
  a = fcntl.fcntl(r1, fcntl.F_DUPFD, 20); b = fcntl.fcntl(w2, fcntl.F_DUPFD, 20); os.dup2(a, 3); os.dup2(b, 4)
prof = tempfile.mkdtemp(prefix='stubyard-recording2-prof-')
args = ['google-chrome', '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + prof,
        '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--allowlisted-extension-id=' + EXT_ID, 'about:blank']
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
def ev(session, expr, timeout=15):
  r = send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True}, session, timeout)
  if 'exceptionDetails' in r: raise RuntimeError('eval: ' + json.dumps(r['exceptionDetails'])[:500])
  return r.get('result', {}).get('value')
def wait_for(fn, timeout=8, step=0.25):
  end = time.time() + timeout; last = None
  while time.time() < end:
    try:
      last = fn()
      if last: return last
    except Exception as e:
      last = e
    time.sleep(step)
  raise AssertionError('timed out: %r' % (last,))

R = {'checks': {}, 'shots': [], 'sizes': []}
def check(name, ok, detail=None):
  R['checks'][name] = {'ok': bool(ok), 'detail': detail}
  print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else '  ' + json.dumps(detail, ensure_ascii=False)[:400]), flush=True)
ONLY = [x for x in os.environ.get('SECTIONS', '').split(',') if x]
def section(name, fn):
  if ONLY and name not in ONLY: return
  try: fn()
  except Exception:
    R['checks'][name + ' (crashed)'] = {'ok': False, 'detail': traceback.format_exc()[-1500:]}
    print('FAIL %s (crashed)\n%s' % (name, traceback.format_exc()[-1500:]), flush=True)

try:
  ext = send('Extensions.loadUnpacked', {'path': DIST})['id']; R['extId'] = ext
  check('the extension id is the allowlisted one', ext == EXT_ID, {'loaded': ext, 'computed': EXT_ID})
  PANEL = 'chrome-extension://%s/sidepanel.html' % ext
  def attach(t):
    s = send('Target.attachToTarget', {'targetId': t, 'flatten': True})['sessionId']; send('Runtime.enable', {}, s); send('Page.enable', {}, s); return s
  ct = send('Target.createTarget', {'url': PANEL, 'newWindow': True})['targetId']; time.sleep(1); cs = attach(ct)
  def cx(expr, timeout=15): return ev(cs, expr, timeout)
  cx('chrome.storage.local.set({apiUrl: %s, widgetHintSeen: true})' % json.dumps(HUB))
  def open_app(url):
    t = send('Target.createTarget', {'url': url, 'newWindow': True})['targetId']; s = attach(t); time.sleep(1.2)
    info = json.loads(cx('chrome.tabs.query({}).then(ts => JSON.stringify(ts.filter(t => t.url.startsWith(%s)).map(t => ({id: t.id, w: t.windowId}))))' % json.dumps(url)))
    return t, s, info[-1]['id'], info[-1]['w']
  pt, ps, TID, WINID = open_app(APP + '/form')
  cx('chrome.storage.local.set({activeWalkthroughByWindow: {[%d]: %s}})' % (WINID, json.dumps({'project': P, 'id': WID, 'origins': [APP]})))
  def nav(s, url, wait=1.5):
    send('Page.navigate', {'url': url}, s); time.sleep(wait)
  nav(ps, APP + '/form', 2.5)
  def offscreen_status(): return cx('chrome.runtime.sendMessage({target: "offscreen", type: "video.status"}).catch(e => String(e))')
  def mouse_path(s, n=60, y0=120):
    for i in range(n):
      send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 80 + (i * 9) % 600, 'y': y0 + (i * 5) % 300}, s); time.sleep(0.04)
  def type_into(s, sel, text):
    ev(s, 'document.querySelector(%s).focus()' % json.dumps(sel))
    for ch in text:
      send('Input.insertText', {'text': ch}, s); time.sleep(0.06)
  def click(s, sel):
    r = ev(s, '(() => { const r = document.querySelector(%s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()' % json.dumps(sel))
    for t in ('mousePressed', 'mouseReleased'):
      send('Input.dispatchMouseEvent', {'type': t, 'x': r[0], 'y': r[1], 'button': 'left', 'clickCount': 1}, s)
  def pill_shown(s):
    # The widget lives in a closed shadow root: read it through the DOM domain (pierce).
    send('DOM.enable', {}, s)
    root = send('DOM.getDocument', {'depth': -1, 'pierce': True}, s)['root']
    stack = [root]
    while stack:
      n = stack.pop()
      a = n.get('attributes') or []
      at = dict(zip(a[0::2], a[1::2]))
      if n.get('nodeName') == 'BUTTON' and at.get('aria-keyshortcuts') == 'Alt+Shift+W': return 'display: block' in at.get('style', '')
      stack += (n.get('children') or []) + (n.get('shadowRoots') or [])
    return None
  def session(): return cx('chrome.storage.session.get(["videoCapture", "videoEnded"])')
  def shot(s, name):
    d = send('Page.captureScreenshot', {'format': 'png'}, s)['data']
    p = os.path.join(SHOTS, name + '.png'); open(p, 'wb').write(base64.b64decode(d)); R['shots'].append(p); return p

  check('a video storyboard warns at start', any('video of the tab' in w for w in W.get('warnings', [])), W.get('warnings'))
  check('the run says mode video', rec()['mode'] == 'video', rec()['mode'])

  # ---- Start: Record video ----
  def start():
    try: wait_for(lambda: pill_shown(ps) is False, 12)  # the widget card is open
    except AssertionError: raise AssertionError('widget card not open: pill_shown=%r' % (pill_shown(ps),))
    t0 = time.time()
    r = cx('chrome.runtime.sendMessage({type: "video.start", tabId: %d})' % TID, 30)
    R['startMs'] = round((time.time() - t0) * 1000)
    check('Record video starts the capture', r == {'ok': True}, r)
    s = session().get('videoCapture') or {}
    check('the capture session is kept (VP9, scaled size)', s.get('mime', '').startswith('video/webm') and s.get('width') == 1280, s)
    check('the widget folds to its pill while video is on', wait_for(lambda: pill_shown(ps), 6))
    again = cx('chrome.runtime.sendMessage({type: "video.start", tabId: %d})' % TID)
    check('a second start is a no-op', again == {'ok': True, 'already': True}, again)
  section('start', start)

  # ---- Page 1: the extension fills a password and a code (dots), typing, step 2 from the hub ----
  def page1():
    for sel, val in (('#pw', SECRET_PW), ('#code', SECRET_OTP)):
      r = cx('chrome.tabs.sendMessage(%d, {type: "setValue", selector: %s, value: %s, origin: %s, secret: true})' % (TID, json.dumps(sel), json.dumps(val), json.dumps(APP)))
      check('fill %s' % sel, bool(r and r.get('ok', True)), r)
    dots = ev(ps, '[...document.querySelectorAll("#pw, #code")].map(e => [e.value.length > 0, getComputedStyle(e).webkitTextSecurity, e.hasAttribute("data-stubyard-video-dots")])')
    check('the extension fills show dots in the page', all(d == [True, 'disc', True] for d in dots), dots)
    type_into(ps, '#email', 'ada.video@example.test')
    type_into(ps, '#name', 'Ada Lovelace')
    shot(ps, 'page-form-dots')
    R['fillMediaAt'] = None
    mouse_path(ps, 40)
    set_step(1)
    time.sleep(6.5)
    l = rec()
    v = [s for s in l['segments'] if s.get('kind') == 'video']
    check('chunks reach the hub every ~5 s (one video segment)', len(v) == 1 and v[0]['bytes'] > 0, {'segments': [(s['no'], s.get('kind'), s['bytes'], s['durationMs']) for s in l['segments']], 'offscreen': offscreen_status(), 'session': session()})
  section('page 1', page1)

  # ---- Page 2: a page load keeps the same capture ----
  def page2():
    n0 = rec()['segmentCount']
    nav(ps, APP + '/next', 2.5)
    for _ in range(3):
      click(ps, '#add'); mouse_path(ps, 15, 150); time.sleep(0.6)
    set_step(2)
    type_into(ps, '#q', 'Order 2')
    time.sleep(6)
    l = rec()
    check('a page load does not start a new segment', l['segmentCount'] == n0 and l['segments'][0]['status'] == 'recording', [(s['no'], s['status']) for s in l['segments']])
    check('dots are back off after the page load (nothing to hide)', ev(ps, '!document.querySelector("[data-stubyard-video-dots]")'))
    check('the widget is a pill on the new page too', wait_for(lambda: pill_shown(ps), 6))
  section('page 2', page2)

  # ---- Another origin: paused (media time stands still) ----
  def other():
    d0 = rec()['segments'][0]['durationMs']
    nav(ps, OTHER + '/next', 2)
    wait_for(lambda: (session().get('videoCapture') or {}).get('paused'), 6)
    s = session().get('videoCapture')
    check('another origin pauses the video', s.get('paused') and s.get('pausedFor') == 'origin', s)
    time.sleep(8)
    nav(ps, APP + '/next', 2)
    wait_for(lambda: not (session().get('videoCapture') or {}).get('paused'), 6)
    mouse_path(ps, 30); time.sleep(6)
    d1 = rec()['segments'][0]['durationMs']
    R['pauseCheck'] = {'before': d0, 'after': d1}
    check('the paused time on the other site is left out of the video', d1 - d0 < 13000, R['pauseCheck'])
  section('other origin', other)

  # ---- The tab closes: the video ends with a final chunk ----
  def close():
    send('Target.closeTarget', {'targetId': pt})
    l = wait_for(lambda: (lambda r: r if r['segments'][0]['status'] == 'complete' else None)(rec()), 20)
    seg = l['segments'][0]
    R['video'] = {k: seg.get(k) for k in ('no', 'kind', 'mime', 'bytes', 'durationMs', 'status', 'events')}
    R['video']['markers'] = seg.get('markers')
    check('closing the tab completes the video', seg['status'] == 'complete', R['video'])
    e = wait_for(lambda: session().get('videoEnded'), 6)
    check('the end reason is kept for the views', 'closed' in e.get('reason', ''), e)
    check('the capture session is gone', not session().get('videoCapture'))
    mk = [m['stepId'] for m in seg.get('markers') or []]
    check('step markers for the 3 steps, in order', mk == SIDS, {'markers': seg.get('markers'), 'steps': SIDS})
    mins = seg['durationMs'] / 60000
    R['sizes'].append({'page': 'form + list, typing (1280x800)', 'seconds': round(seg['durationMs'] / 1000, 1), 'KB': round(seg['bytes'] / 1024, 1), 'MBperMin': round(seg['bytes'] / 1048576 / mins, 2)})
  section('tab closed', close)

  # ---- The file: content type, Range, duration ----
  def served():
    no = R['video']['no']; stored = R['video']['bytes']
    st, h, data = http_req('GET', seg_path(no))
    hl = {k.lower(): v for k, v in h.items()}
    size = int(hl.get('content-length', -1))
    R['video']['servedBytes'] = size
    seghdr = json.loads(hl.get('x-recording-segment', '{}'))
    check('the segment carries the step it started on', seghdr.get('stepId') == SIDS[0], seghdr)
    check('served as video/webm with Accept-Ranges', st == 200 and hl.get('content-type', '').startswith('video/webm') and hl.get('accept-ranges') == 'bytes', {k: hl.get(k) for k in ('content-type', 'accept-ranges', 'content-length')})
    check('the whole file comes back (stored size + the Duration the hub writes in)', len(data) == size and 0 <= size - stored <= 32, [len(data), size, stored])
    check('it is a WebM file (EBML header)', data[:4] == b'\x1a\x45\xdf\xa3')
    check('the hub wrote a Duration into it', b'\x44\x89\x88' in data[:400])
    open(os.path.join(OUT, 'video.webm'), 'wb').write(data)
    st, h, part = http_req('GET', seg_path(no), headers={'range': 'bytes=1000-1999'})
    hl = {k.lower(): v for k, v in h.items()}
    check('Range gives 206 with the bytes asked for', st == 206 and part == data[1000:2000] and hl.get('content-range') == 'bytes 1000-1999/%d' % size, [st, hl.get('content-range'), len(part)])
    st, h, _ = http_req('GET', seg_path(no), headers={'range': 'bytes=%d-' % (size + 10)})
    check('a range past the end is 416', st == 416, st)
  section('served', served)

  # ---- A busy page (animation all the time) for the worst-case size, in a 1920 px window ----
  def busy():
    global P2, W2
    P2 = 'video-qa-busy-%d' % T0
    W2 = make_project(P2, {'appOrigins': [APP]})
    t, s, tid, win = open_app(APP + '/anim')
    wid = send('Browser.getWindowForTarget', {'targetId': t})['windowId']
    send('Browser.setWindowBounds', {'windowId': wid, 'bounds': {'width': 1920, 'height': 1080}})
    time.sleep(1)
    cx('chrome.storage.local.get("activeWalkthroughByWindow").then(r => chrome.storage.local.set({activeWalkthroughByWindow: {...r.activeWalkthroughByWindow, [%d]: %s}}))' % (win, json.dumps({'project': P2, 'id': W2['id'], 'origins': [APP]})))
    time.sleep(1.5)
    r = cx('chrome.runtime.sendMessage({type: "video.start", tabId: %d})' % tid, 30)
    check('busy page: the capture starts', r == {'ok': True}, r)
    vs = session().get('videoCapture') or {}
    vp = ev(s, '[innerWidth, innerHeight]')
    check('a 1920 px wide tab is captured at 1280 px wide', vs.get('width') == 1280 and vs.get('height') == round(vp[1] * 1280 / vp[0] / 2) * 2, {'viewport': vp, 'captured': [vs.get('width'), vs.get('height')]})
    time.sleep(31)
    R['busyStatus'] = offscreen_status()
    api('POST', '/api/projects/%s/walkthroughs/%s/abandon' % (P2, W2['id']), {})
    l = wait_for(lambda: (lambda r: r if r['segments'] and r['segments'][0]['status'] == 'complete' else None)(rec(P2, W2['id'])), 25)
    seg = l['segments'][0]
    e = session().get('videoEnded') or {}
    check('the run ending stops the video', 'ended' in e.get('reason', ''), e)
    mins = seg['durationMs'] / 60000
    R['sizes'].append({'page': 'animation all the time (1280x720 of a 1920x1080 tab)', 'seconds': round(seg['durationMs'] / 1000, 1), 'KB': round(seg['bytes'] / 1024, 1), 'MBperMin': round(seg['bytes'] / 1048576 / mins, 2)})
    send('Target.closeTarget', {'targetId': t})
  section('busy page', busy)

  # ---- The cap: a project with a tiny limit ----
  def cap():
    P3 = 'video-qa-cap-%d' % T0
    W3 = make_project(P3, {'appOrigins': [APP], 'recordingMaxMb': 0.4})
    t, s, tid, win = open_app(APP + '/anim')
    cx('chrome.storage.local.get("activeWalkthroughByWindow").then(r => chrome.storage.local.set({activeWalkthroughByWindow: {...r.activeWalkthroughByWindow, [%d]: %s}}))' % (win, json.dumps({'project': P3, 'id': W3['id'], 'origins': [APP]})))
    time.sleep(1.5)
    r = cx('chrome.runtime.sendMessage({type: "video.start", tabId: %d})' % tid, 30)
    check('cap: the capture starts', r == {'ok': True}, r)
    e = wait_for(lambda: (session().get('videoEnded') or {}).get('walkthroughId') == W3['id'] and session()['videoEnded'], 90, 1)
    l = rec(P3, W3['id'])
    seg = l['segments'][0]
    R['cap'] = {'maxBytes': l['maxBytes'], 'bytes': l['bytes'], 'stopped': l['stopped'], 'reason': e.get('reason'), 'segment': [seg['status'], seg['bytes'], seg['durationMs']]}
    check('the cap stops the video before the limit, with a complete file', 'limit' in e.get('reason', '') and l['bytes'] <= l['maxBytes'] and seg['status'] == 'complete', R['cap'])
    st, h, data = http_req('GET', seg_path(seg['no'], P3, W3['id']))
    check('the capped video is a whole WebM', st == 200 and 0 <= len(data) - seg['bytes'] <= 32 and data[:4] == b'\x1a\x45\xdf\xa3', [st, len(data)])
    send('Target.closeTarget', {'targetId': t})
  section('cap', cap)

  # ---- Dashboard: the Recording tab plays the video ----
  def dashboard():
    dt = send('Target.createTarget', {'url': 'about:blank', 'newWindow': True})['targetId']; ds = attach(dt)
    url = '%s/p/%s/storyboards?tab=walkthroughs&wt=%s' % (HUB, P, WID)
    def open_tab(width, theme):
      send('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 1000 if width >= 1280 else 900, 'deviceScaleFactor': 1, 'mobile': width < 480}, ds)
      send('Page.navigate', {'url': HUB + '/'}, ds); time.sleep(0.8)
      ev(ds, 'localStorage.setItem("stubyard.theme", %s)' % json.dumps(json.dumps(theme)))
      send('Page.navigate', {'url': url}, ds)
      wait_for(lambda: ev(ds, '!!document.querySelector(".drawer")'), 12)
      ev(ds, '[...document.querySelectorAll(".drawer .seg-btn")].find(b => b.textContent.startsWith("Recording")).click()')
      wait_for(lambda: ev(ds, '!!document.querySelector("video.rec-video")'), 15)
      wait_for(lambda: ev(ds, '!document.querySelector(".rec-play").disabled'), 15)
      time.sleep(0.6)
    def vstate(): return ev(ds, '(() => { const v = document.querySelector("video.rec-video"); return {d: v.duration, t: v.currentTime, rate: v.playbackRate, ready: v.readyState, paused: v.paused, w: v.videoWidth, h: v.videoHeight, err: v.error && v.error.message}; })()')
    open_tab(1280, 'dark')
    v = vstate()
    dur = R['video']['durationMs'] / 1000
    check('the <video> knows the duration (from the file)', v['d'] and abs(v['d'] - dur) < 6 and v['d'] != float('inf'), {'video': v, 'segment s': dur})
    check('the video is 1280 px wide', v['w'] == 1280, [v['w'], v['h']])
    mk = ev(ds, 'document.querySelectorAll(".rec-marker").length')
    check('the player shows the 3 step markers', mk == 3, mk)
    titles = ev(ds, '[...document.querySelectorAll(".rec-step")].map(b => b.innerText)')
    check('step markers carry the step titles', any(STEPS[1][0] in t for t in titles), titles)
    at = R['video']['markers'][2]['at'] / 1000
    ev(ds, 'document.querySelectorAll(".rec-marker")[2].click()')
    wait_for(lambda: ev(ds, '!document.querySelector("video.rec-video").seeking'), 6)
    v = vstate()
    on = ev(ds, '[...document.querySelectorAll(".rec-step")].findIndex(b => b.classList.contains("on"))')
    check('a marker seeks the video to its step', abs(v['t'] - at) < 0.6 and on == 2, {'t': v['t'], 'marker': at, 'active': on})
    ev(ds, '[...document.querySelectorAll(".rec-speed .seg-btn")].find(b => b.textContent === "2x").click()')
    ev(ds, 'document.querySelectorAll(".rec-marker")[0].click()'); time.sleep(0.5)
    t0 = vstate()['t']
    ev(ds, 'document.querySelector(".rec-play").click()'); time.sleep(2)
    v = vstate()
    ev(ds, 'document.querySelector(".rec-play").click()')
    check('plays at 2x', v['rate'] == 2 and not v['paused'] and v['t'] - t0 > 2.5, {'from': t0, 'state': v})
    # A frame from just after the fills (step 1): the password and the code are dots in the video too.
    ev(ds, '(() => { const v = document.querySelector("video.rec-video"); v.currentTime = 4; })()')
    wait_for(lambda: ev(ds, '!document.querySelector("video.rec-video").seeking'), 6); time.sleep(0.4)
    png = ev(ds, '(() => { const v = document.querySelector("video.rec-video"); const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0); return c.toDataURL("image/png").split(",")[1]; })()')
    p = os.path.join(SHOTS, 'video-frame-after-fills.png'); open(p, 'wb').write(base64.b64decode(png)); R['shots'].append(p)
    check('a frame of the video was grabbed (look: password and code are dots, widget is a pill)', len(png) > 1000, p)
    overflow = ev(ds, '(() => { const d = document.querySelector(".drawer"); return d.scrollWidth > d.clientWidth + 1; })()')
    check('no horizontal overflow at 1280', not overflow)
    ev(ds, 'document.querySelectorAll(".rec-marker")[1].click()'); time.sleep(0.8)
    shot(ds, 'video-player-1280-dark')
    for w in (390, 768, 1920):
      open_tab(w, 'dark')
      ev(ds, 'document.querySelectorAll(".rec-marker")[1]?.click()'); time.sleep(0.8)
      ov = ev(ds, '(() => { const d = document.querySelector(".drawer"); return d.scrollWidth > d.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1; })()')
      check('no horizontal overflow at %d' % w, not ov)
      shot(ds, 'video-player-%d-dark' % w)
    for w in (390, 1280):
      open_tab(w, 'light')
      ev(ds, 'document.querySelectorAll(".rec-marker")[1]?.click()'); time.sleep(0.8)
      shot(ds, 'video-player-%d-light' % w)
  section('dashboard', dashboard)
finally:
  json.dump(R, open(os.path.join(OUT, 'results.json'), 'w'), indent=1)
  print('SIZES', json.dumps(R['sizes']), flush=True)
  fails = [k for k, v in R['checks'].items() if not v['ok']]
  print('\n%d checks, %d failed%s' % (len(R['checks']), len(fails), (': ' + ', '.join(fails)) if fails else ''), flush=True)
  try: proc.terminate()
  except Exception: pass
  for s in servers: s.shutdown()
