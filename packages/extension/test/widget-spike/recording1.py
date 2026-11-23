#!/usr/bin/env python3
# Walkthrough recording R1 (rrweb DOM recording): a real headless Chrome check of the BUILT test extension
# (dist-test/, npm run build:test) against a running throwaway stubyard (default http://127.0.0.1:48000) whose
# dashboard is built (web/dist), with fixture app pages served here on 127.0.0.1:48011 (the run's origin) and
# 127.0.0.1:48012 (another origin). Not part of npm test. Build first:
#   ./scripts/npm.sh run build && ./scripts/npm.sh run build:test -w @stubyard/extension
#   python3 -I packages/extension/test/widget-spike/recording1.py [OUT_DIR] [HUB_URL]
# Start the hub after building web/: it serves the dashboard files it found at start. A throwaway hub on 48000:
#   STUBYARD_DOCKER_ARGS="-p 127.0.0.1:48000:4000 -e STUBYARD_HOST=0.0.0.0 -e STUBYARD_DATA_DIR=/tmp/rec-qa \
#     --name stubyard-rec-qa" ./scripts/npm.sh exec -w server -- tsx src/index.ts      (docker stop stubyard-rec-qa)
# SHOTS_DIR=<dir> puts the dashboard screenshots there (default OUT_DIR).
# What it checks:
#  - a tracked run of a storyboard with record: dom records the run's app pages: one segment per page load (2 pages),
#    tagged with the url and the step; step changes made elsewhere (the hub) become step markers;
#  - passwords and one-time codes typed into the page never reach the hub (masked); a plain email does;
#  - the on-page widget is not recorded (its step titles are nowhere in the events);
#  - Pause stops recording (the segment ends), Resume starts a new segment; another origin is never recorded;
#  - the red dot: the widget card shows "Recording", the collapsed pill carries the dot;
#  - sizes: stored (gzip) and raw KB per minute of every segment;
#  - the dashboard: the walkthrough drawer's Recording tab plays a segment, shows the step markers, a marker jumps
#    there; screenshots at 390 / 768 / 1280 / 1920 px (dark) and 390 / 1280 px (light).
import os, re, sys, json, time, threading, subprocess, http.server, socketserver, fcntl, traceback, tempfile, urllib.request, base64, select, gzip

WS = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.abspath(os.path.join(WS, '..', '..', 'dist-test'))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='stubyard-recording1-')
HUB = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:48000'
os.makedirs(OUT, exist_ok=True)
APP = 'http://127.0.0.1:48011'
OTHER = 'http://127.0.0.1:48012'
SECRET_PW = 'hunter2-Sekr3t!'
SECRET_OTP = '493817'
EMAIL = 'ada.recorded@example.test'
FILLER = ''.join('<p>Paragraph %d of the app page. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</p>' % i for i in range(30))
STYLE = '<style>body{font:15px/1.5 system-ui;margin:24px;background:#f4f6fb;color:#1c2333} .card{background:#fff;border:1px solid #dde3ee;border-radius:10px;padding:16px;margin:12px 0;max-width:560px} input{display:block;margin:4px 0 12px;padding:8px;width:100%;box-sizing:border-box} button{padding:8px 16px} li{padding:6px 0;border-bottom:1px solid #eee}</style>'
FORM = ('<div class="card"><form onsubmit="return false"><label>Email <input id="email" name="email" type="email"></label>'
        '<label>Password <input id="pw" name="password" type="password"></label>'
        '<label>Verification code <input id="code" name="code" autocomplete="one-time-code" inputmode="numeric"></label>'
        '<label>Full name <input id="name" name="fullname"></label><button type="submit">Sign in</button></form></div>')
LIST = ('<div class="card"><button id="add" onclick="const li=document.createElement(\'li\');li.textContent=\'Order #\'+(document.querySelectorAll(\'#orders li\').length+1)+\' created at \'+new Date().toLocaleTimeString();document.getElementById(\'orders\').append(li)">Add order</button>'
        '<ul id="orders"></ul><label>Search <input id="q" name="q"></label></div>')
PAGES = {'/form': ('Sign in', FORM + FILLER), '/next': ('Orders', LIST + FILLER)}
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
for port in (48011, 48012):
  s = TS(('127.0.0.1', port), App); threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)

def api(method, path, body=None, raw=False):
  req = urllib.request.Request(HUB + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'content-type': 'application/json', 'accept-encoding': 'gzip'})
  try:
    with urllib.request.urlopen(req, timeout=15) as r:
      data = r.read()
      if r.headers.get('content-encoding') == 'gzip': data = gzip.decompress(data)
      if raw: return data.decode()
      t = data.decode(); return json.loads(t) if t else None
  except urllib.error.HTTPError as e:
    raise RuntimeError('%s %s: %s %s' % (method, path, e.code, e.read().decode()[:600]))

P = 'recording-qa-%d' % int(time.time())
api('POST', '/api/projects', {'name': 'Recording QA', 'slug': P, 'settings': {'appOrigins': [APP]}})
STEPS = [('Sign in with the test account', 'Type the email, the password and the code.'), ('Check the order list', 'Add two orders.'), ('Search an order', 'Search for order 2.')]
bundle = {
  'format': 'stubyard-storyboards', 'version': 1,
  'users': [{'email': 'ada@example.test', 'name': 'Ada Admin', 'role': 'admin', 'password': 'pw-123456'}],
  'storyboards': [{'slug': 'recorded', 'name': 'Recorded checkout', 'record': 'dom', 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}],
                   'steps': [{'kind': 'instruction', 'title': t, 'intent': i} for t, i in STEPS]}],
}
api('POST', '/api/projects/%s/storyboards/import' % P, {'bundle': bundle})
W = api('POST', '/api/projects/%s/walkthroughs' % P, {'storyboard': 'recorded', 'origin': APP, 'mode': 'tracked'})
WID = W['id']; SIDS = [s['id'] for s in W['steps']]
def getw(): return api('GET', '/api/projects/%s/walkthroughs/%s' % (P, WID))
def rec(): return api('GET', '/api/projects/%s/walkthroughs/%s/recording' % (P, WID))
def seg_events(no): return [json.loads(l) for l in api('GET', '/api/projects/%s/walkthroughs/%s/recording/segments/%d' % (P, WID, no), raw=True).splitlines() if l.strip()]
def seg_raw(no): return api('GET', '/api/projects/%s/walkthroughs/%s/recording/segments/%d' % (P, WID, no), raw=True)
def set_step(i): api('PATCH', '/api/projects/%s/walkthroughs/%s' % (P, WID), {'currentStepId': SIDS[i]})

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


R = {'checks': {}, 'shots': [], 'sizes': []}
def check(name, ok, detail=None):
  R['checks'][name] = {'ok': bool(ok), 'detail': detail}
  print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else '  ' + json.dumps(detail, ensure_ascii=False)[:400]), flush=True)
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
  ct = send('Target.createTarget', {'url': PANEL, 'newWindow': True})['targetId']; time.sleep(1); cs = attach(ct)
  def cx(expr): return ev(cs, expr)
  cx('chrome.storage.local.set({apiUrl: %s, widgetHintSeen: true})' % json.dumps(HUB))
  pt = send('Target.createTarget', {'url': APP + '/form', 'newWindow': True})['targetId']; ps = attach(pt)
  time.sleep(1)
  tab = json.loads(cx('chrome.tabs.query({url: "%s/*"}).then(t => JSON.stringify({id: t[0].id, w: t[0].windowId}))' % APP))
  TID, WINID = tab['id'], tab['w']
  a = {'project': P, 'id': WID, 'origins': [APP]}
  cx('chrome.storage.local.set({activeWalkthroughByWindow: {[%d]: %s}})' % (WINID, json.dumps(a)))
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
  def widget_text():
    for s in reversed(frame_sessions()):
      try: return ev(s, 'document.body.innerText') or ''
      except (TimeoutError, RuntimeError): continue
    return ''
  def nav(url, wait=1.5):
    send('Page.navigate', {'url': url}, ps); time.sleep(wait)
  def type_into(sel, text):
    ev(ps, 'document.querySelector(%s).focus()' % json.dumps(sel))
    for ch in text:
      send('Input.insertText', {'text': ch}, ps); time.sleep(0.06)
  def mouse_path(n=60, y0=120):
    for i in range(n):
      send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 80 + (i * 9) % 600, 'y': y0 + (i * 5) % 300}, ps); time.sleep(0.04)
  def click(sel):
    r = ev(ps, '(() => { const r = document.querySelector(%s).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()' % json.dumps(sel))
    for t in ('mousePressed', 'mouseReleased'):
      send('Input.dispatchMouseEvent', {'type': t, 'x': r[0], 'y': r[1], 'button': 'left', 'clickCount': 1}, ps)
  def scroll(dy):
    send('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': 300, 'y': 300, 'deltaX': 0, 'deltaY': dy}, ps); time.sleep(0.2)

  # ---- Page 1: /form (step 1, then step 2 set from the hub) ----
  def page1():
    nav(APP + '/form', 2.5)
    l = wait_for(lambda: (lambda r: r if r['segmentCount'] >= 1 else None)(rec()), 14)
    check('a segment is recorded on the run origin', l['segments'][0]['url'].startswith(APP + '/form'), {'segments': [(s['no'], s['url'], s['status']) for s in l['segments']]})
    check('segment tagged with the current step', l['segments'][0]['stepId'] == SIDS[0], l['segments'][0]['stepId'])
    wt = wait_for(lambda: 'Recording' in widget_text() and widget_text(), 10)
    check('widget card shows the recording line', 'Recording' in wt)
    mouse_path(40)
    type_into('#email', EMAIL)
    type_into('#pw', SECRET_PW)
    type_into('#code', SECRET_OTP)
    type_into('#name', 'Ada Lovelace')
    scroll(400); scroll(400); mouse_path(30, 200); scroll(-800)
    set_step(1)  # the tester moved on in the panel
    time.sleep(3)
    mouse_path(40)
    time.sleep(6)
  section('page 1', page1)

  # ---- Page 2: /next (another page load: a new segment) ----
  def page2():
    nav(APP + '/next', 2.5)
    for _ in range(3):
      click('#add'); mouse_path(15, 150); time.sleep(0.6)
    scroll(300)
    set_step(2)
    time.sleep(2)
    type_into('#q', 'Order 2')
    mouse_path(50)
    time.sleep(6)
    l = rec()
    check('one segment per page load (2 pages)', [s['url'].split(APP)[1] for s in l['segments']][:2] == ['/form', '/next'], [(s['no'], s['url'], s['status'], s['stepId']) for s in l['segments']])
    check('the first segment ended on navigation (final chunk)', l['segments'][0]['status'] == 'complete', l['segments'][0]['status'])
  section('page 2', page2)

  # ---- Pause and resume ----
  def pause_resume():
    api('PATCH', '/api/projects/%s/walkthroughs/%s/recording' % (P, WID), {'paused': True})
    time.sleep(3)
    before = rec()
    s2 = before['segments'][1]
    check('pause ends the segment', s2['status'] == 'complete', s2['status'])
    mouse_path(40); click('#add'); time.sleep(6)
    after = rec()
    check('nothing is recorded while paused', after['segmentCount'] == before['segmentCount'] and after['bytes'] == before['bytes'], {'before': before['bytes'], 'after': after['bytes']})
    api('PATCH', '/api/projects/%s/walkthroughs/%s/recording' % (P, WID), {'paused': False})
    l = wait_for(lambda: (lambda r: r if r['segmentCount'] > before['segmentCount'] else None)(rec()), 14)
    check('resume starts a new segment', l['segments'][-1]['url'].startswith(APP + '/next'), [(s['no'], s['url'], s['status']) for s in l['segments']])
    mouse_path(30); time.sleep(5.5)
  section('pause and resume', pause_resume)

  # ---- The pill dot (collapsed widget) ----
  def pill():
    for s in frame_sessions():
      try: ev(s, 'document.querySelector("button[aria-label=\\"Collapse the widget\\"]")?.click()')
      except Exception: pass
    time.sleep(0.8)
    lbl = ev(ps, '(() => { const h = document.querySelector("[data-stubyard-widget]"); return h ? "host" : "none"; })()')
    d = send('Page.captureScreenshot', {'format': 'png'}, ps)['data']
    p = os.path.join(OUT, 'pill-recording.png'); open(p, 'wb').write(base64.b64decode(d)); R['shots'].append(p)
    check('widget host present (pill screenshot taken)', lbl == 'host', p)
  section('pill', pill)

  # ---- Another origin: not recorded; the last segment ends ----
  def other():
    n = rec()['segmentCount']
    nav(OTHER + '/form', 3); mouse_path(30); time.sleep(6)
    l = rec()
    check('another origin is never recorded', l['segmentCount'] == n and not any(s['url'].startswith(OTHER) for s in l['segments']), [(s['no'], s['url']) for s in l['segments']])
    check('every segment is complete after leaving', all(s['status'] == 'complete' for s in l['segments']), [(s['no'], s['status']) for s in l['segments']])
  section('other origin', other)

  # ---- Content: masking, widget not recorded, markers; sizes ----
  def content():
    l = rec()
    allraw = ''
    for s in l['segments']:
      raw = seg_raw(s['no']); allraw += raw
      evs = [json.loads(x) for x in raw.splitlines() if x.strip()]
      mins = max(s['durationMs'], 1) / 60000
      R['sizes'].append({'no': s['no'], 'url': s['url'].split(APP)[1], 'seconds': round(s['durationMs'] / 1000, 1), 'events': s['events'], 'storedKB': round(s['bytes'] / 1024, 1), 'rawKB': round(len(raw.encode()) / 1024, 1),
                         'storedKBperMin': round(s['bytes'] / 1024 / mins, 1), 'rawKBperMin': round(len(raw.encode()) / 1024 / mins, 1), 'types': sorted(set(e['type'] for e in evs))})
    check('the password never reaches the hub', SECRET_PW not in allraw)
    check('the one-time code never reaches the hub', SECRET_OTP not in allraw)
    check('a plain email is recorded (not masked by default)', EMAIL in allraw)
    check('masked input values show as *', '*' * len(SECRET_PW) in allraw)
    check('the widget is not recorded (no step titles in the events)', not any(t in allraw for t, _ in STEPS))
    evs1 = seg_events(l['segments'][0]['no'])
    marks = [e['data']['payload']['stepId'] for e in evs1 if e['type'] == 5 and e['data'].get('tag') == 'stubyard.step']
    check('segment 1 has step markers for step 1 and step 2', marks[:1] == [SIDS[0]] and SIDS[1] in marks, marks)
    check('segment 1 starts with Meta + FullSnapshot', [e['type'] for e in evs1[:2]] == [4, 2], [e['type'] for e in evs1[:3]])
    tot_b = sum(s['bytes'] for s in l['segments']); tot_ms = sum(s['durationMs'] for s in l['segments'])
    R['total'] = {'segments': len(l['segments']), 'seconds': round(tot_ms / 1000, 1), 'storedKB': round(tot_b / 1024, 1), 'storedKBperMin': round(tot_b / 1024 / (tot_ms / 60000), 1),
                  'rawKB': round(len(allraw.encode()) / 1024, 1), 'rawKBperMin': round(len(allraw.encode()) / 1024 / (tot_ms / 60000), 1)}
    print('SIZES', json.dumps(R['sizes']), '\nTOTAL', json.dumps(R['total']), flush=True)
  section('content', content)

  # ---- Dashboard: the Recording tab ----
  def dashboard():
    dt = send('Target.createTarget', {'url': 'about:blank', 'newWindow': True})['targetId']; ds = attach(dt)
    shots_dir = os.environ.get('SHOTS_DIR') or OUT
    os.makedirs(shots_dir, exist_ok=True)
    url = '%s/p/%s/storyboards?tab=walkthroughs&wt=%s' % (HUB, P, WID)
    def open_tab(width, theme):
      send('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 1000 if width >= 1280 else 900, 'deviceScaleFactor': 1, 'mobile': width < 480}, ds)
      send('Page.navigate', {'url': HUB + '/'}, ds); time.sleep(0.8)
      ev(ds, 'localStorage.setItem("stubyard.theme", %s)' % json.dumps(json.dumps(theme)))
      send('Page.navigate', {'url': url}, ds)
      try: wait_for(lambda: ev(ds, '!!document.querySelector(".drawer")'), 12)
      except AssertionError:
        raise AssertionError('no drawer; page: %r' % (ev(ds, 'location.href + " | " + document.body.innerText.slice(0, 400)'),))
      ev(ds, '[...document.querySelectorAll(".drawer .seg-btn")].find(b => b.textContent.startsWith("Recording")).click()')
      wait_for(lambda: ev(ds, '!!document.querySelector(".rec-host iframe") && document.querySelectorAll(".rec-seg").length'), 15)
      wait_for(lambda: ev(ds, '!document.querySelector(".rec-play").disabled'), 10)
      time.sleep(0.8)
    def snap(name):
      d = send('Page.captureScreenshot', {'format': 'png'}, ds)['data']
      p = os.path.join(shots_dir, name + '.png'); open(p, 'wb').write(base64.b64decode(d)); R['shots'].append(p); return p
    open_tab(1280, 'dark')
    n = ev(ds, 'document.querySelectorAll(".rec-seg").length')
    check('dashboard lists the segments', n == rec()['segmentCount'], n)
    mk = ev(ds, 'document.querySelectorAll(".rec-marker").length')
    check('player shows the step markers of segment 1', mk >= 2, mk)
    titles = ev(ds, '[...document.querySelectorAll(".rec-step")].map(b => b.innerText)')
    check('step markers carry the step titles', any(STEPS[1][0] in t for t in titles), titles)
    ev(ds, 'document.querySelectorAll(".rec-marker")[1].click()')
    time.sleep(0.8)
    t1 = ev(ds, 'document.querySelector(".rec-time").innerText')
    on = ev(ds, '[...document.querySelectorAll(".rec-step")].findIndex(b => b.classList.contains("on"))')
    check('a marker jumps to its step', on == 1, {'time': t1, 'active': on})
    replay = ev(ds, '(() => { const f = document.querySelector(".rec-host iframe"); try { return f.contentDocument.body.innerText.slice(0, 200); } catch (e) { return "err " + e.message; } })()')
    check('the replay shows the recorded page', 'Sign in' in (replay or ''), replay)
    ev(ds, '[...document.querySelectorAll(".rec-speed .seg-btn")].find(b => b.textContent === "4x").click()')
    ev(ds, 'document.querySelector(".rec-play").click()'); time.sleep(1.5)
    playing = ev(ds, 'document.querySelector(".rec-play").getAttribute("aria-label")')
    check('play at 4x', playing == 'Pause playback', playing)
    ev(ds, 'document.querySelector(".rec-play").click()')
    ev(ds, 'document.querySelectorAll(".rec-marker")[1].click()'); time.sleep(0.6)
    overflow = ev(ds, 'document.querySelector(".drawer").scrollWidth > document.querySelector(".drawer").clientWidth + 1')
    check('no horizontal overflow at 1280', not overflow)
    snap('player-1280-dark')
    for w in (390, 768, 1920):
      open_tab(w, 'dark')
      ev(ds, 'document.querySelectorAll(".rec-marker")[1]?.click()'); time.sleep(0.6)
      ov = ev(ds, '(() => { const d = document.querySelector(".drawer"); return d.scrollWidth > d.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1; })()')
      check('no horizontal overflow at %d' % w, not ov)
      snap('player-%d-dark' % w)
    for w in (390, 1280):
      open_tab(w, 'light')
      ev(ds, 'document.querySelectorAll(".rec-marker")[1]?.click()'); time.sleep(0.6)
      snap('player-%d-light' % w)
    # Segment 2 plays too.
    ev(ds, 'document.querySelectorAll(".rec-seg")[1].click()')
    wait_for(lambda: ev(ds, '(() => { const f = document.querySelector(".rec-host iframe"); try { return f && f.contentDocument.body.innerText.includes("Orders"); } catch (e) { return false; } })()'), 12)
    check('segment 2 plays (the orders page)', True)
  section('dashboard', dashboard)
finally:
  json.dump(R, open(os.path.join(OUT, 'results.json'), 'w'), indent=1)
  fails = [k for k, v in R['checks'].items() if not v['ok']]
  print('\n%d checks, %d failed%s' % (len(R['checks']), len(fails), (': ' + ', '.join(fails)) if fails else ''), flush=True)
  try: proc.terminate()
  except Exception: pass
  for s in servers: s.shutdown()
