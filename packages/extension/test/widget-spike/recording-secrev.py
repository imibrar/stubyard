#!/usr/bin/env python3
# Walkthrough recording privacy regression (the security review of R1, docs/drafts/recording-security.md): a real
# headless Chrome run of the BUILT test extension (dist-test/) against a running throwaway stubyard whose dashboard is
# built, with fixture pages served here on 127.0.0.1:APP_PORT (the run's origin, default 48311) and APP_PORT+1 (a
# "remote" site that must never be contacted). Not part of npm test. Build first:
#   ./scripts/npm.sh run build && ./scripts/npm.sh run build:test -w @stubyard/extension
#   STUBYARD_DOCKER_ARGS="-p 127.0.0.1:48300:4000 -e STUBYARD_HOST=0.0.0.0 -e STUBYARD_DATA_DIR=/tmp/rec-sec \
#     --name stubyard-rec-sec" ./scripts/npm.sh exec -w server -- tsx src/index.ts      (docker stop stubyard-rec-sec)
#   python3 -I packages/extension/test/widget-spike/recording-secrev.py [OUT_DIR] [HUB_URL]
# It types secrets into every kind of field the review found leaking (split code boxes, a card number, a text input
# shown as dots, an API key, a show-password toggle, an input swapped for a text one, a password shown while paused,
# contenteditable, a hidden input, a TOTP seed on the page, a token in the URL), with the storyboard unmasking every
# input (recordPrivacy.unmaskSelectors ['input']) so the heuristics alone must hold; then the server limits (empty
# chunks, a compressible chunk, a non-latin URL, a chunk after the run ended, a chunk while paused), a 9 MB page, and a
# forged recording replayed in the dashboard (no script runs, no request leaves). Prints PASS / FAIL per check and
# exits 1 when any check fails.
import os, re, sys, json, time, threading, subprocess, http.server, socketserver, fcntl, traceback, tempfile, urllib.request, urllib.error, base64, select, gzip
WS = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.abspath(os.path.join(WS, '..', '..', 'dist-test'))
OUT = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='stubyard-recsec-')
HUB = sys.argv[2] if len(sys.argv) > 2 else 'http://127.0.0.1:48300'
os.makedirs(OUT, exist_ok=True)
APP_PORT = int(os.environ.get('APP_PORT', '48311')); OTHER_PORT = APP_PORT + 1
APP = 'http://127.0.0.1:%d' % APP_PORT; OTHER = 'http://127.0.0.1:%d' % OTHER_PORT
S = dict(TGL_A='tglA-Pw-91x', TGL_B='AFTERTGL55', SWAP='swapPw-7Qz', CARD='4242424242424242', PWTEXT='textsec-Pw-55k', APIKEY='sk_live_APIKEY_abc123',
         HIDDEN='HIDDEN-CSRF-SECRET-777', CE='contentEditable-secret-88', CTL='ctl-React-pw-66', SHADOWPW='shadow-pw-44', IFRAMEPW='iframe-pw-33', URLTOK='URLTOKEN-RESET-9f8e7d',
         PAUSEDPW='paused-show-pw-22', RACE='RACEafterpause11RACEafterpause11', MA_PLAIN='maskall-plain-xx', MA_CE='maskall-ce-secret', TOTPTEXT='JBSWY3DP-TOTP-SEED-TEXT', OTPNAME='557799', PLAIN='plain-visible-note')
DIGITS = '840271'
LEAK = '''<h2>Leak fixture</h2><p id="seed">Your authenticator key: %(TOTPTEXT)s</p>
<form onsubmit="return false">
<input id="pw" type="password" name="password"><button id="show" type="button" onclick="pw.type = pw.type==='password'?'text':'password'">show</button>
<span id="swapwrap"><input id="pw2" type="password" name="pw2"></span><button id="swap" type="button" onclick="(()=>{const o=document.getElementById('pw2');const n=document.createElement('input');n.id='pw2';n.type='text';n.setAttribute('value',o.value);n.value=o.value;o.replaceWith(n)})()">swap</button>
<div id="digits"><input class="d" maxlength="1" inputmode="numeric"><input class="d" maxlength="1" inputmode="numeric"><input class="d" maxlength="1" inputmode="numeric"><input class="d" maxlength="1" inputmode="numeric"><input class="d" maxlength="1" inputmode="numeric"><input class="d" maxlength="1" inputmode="numeric"></div>
<input id="otpname" name="otp_code">
<input id="card" name="cardnumber" placeholder="Card number">
<input id="pwtext" name="password" type="text" style="-webkit-text-security:disc">
<input id="apikey" name="api_key">
<input type="hidden" name="csrf" value="%(HIDDEN)s">
<input id="ctl" type="password" oninput="this.setAttribute('value', this.value)">
<input id="pw4" type="password" name="pw4"><button id="show4" type="button" onclick="pw4.type='text'">show4</button>
<input id="note" name="note">
<input id="ma" name="plainfield">
</form>
<div id="ce" contenteditable="true" style="border:1px solid #999;min-height:20px"></div>
<div id="sh"></div><script>const r=document.getElementById('sh').attachShadow({mode:'open'});r.innerHTML='<input id="spw" type="password">';</script>
<iframe id="fr" src="/inner" style="width:300px;height:60px"></iframe>''' % S
INNER = '<input id="ipw" type="password"><input id="iplain" name="note2">'
PAGES = {'/leak': LEAK, '/inner': INNER, '/plain': '<h2>plain</h2><input id="note" name="note">'}
HITS = []
class App(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    port = self.server.server_address[1]
    path = self.path.split('?')[0]
    if port == OTHER_PORT:
      HITS.append({'path': self.path, 'referer': self.headers.get('Referer'), 'dest': self.headers.get('Sec-Fetch-Dest')})
      ct = 'text/css' if path.endswith('.css') else 'image/png' if path.endswith('.png') else 'text/html'
      self.send_response(200); self.send_header('Content-Type', ct); self.end_headers(); self.wfile.write(b'<script>try{top.__xss="remote-doc"}catch(e){}</script>' if ct == 'text/html' else b''); return
    if path == '/big':
      b = ('<!doctype html><html><body><h2>big</h2>' + ''.join('<p data-i="%d">%s</p>' % (i, 'x' * 900) for i in range(10000)) + '</body></html>').encode()
    elif path in PAGES:
      b = ('<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>%s</body></html>' % PAGES[path]).encode()
    else: return self.send_error(404)
    self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(b)
class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
servers = []
for port in (APP_PORT, OTHER_PORT):
  s = TS(('127.0.0.1', port), App); threading.Thread(target=s.serve_forever, daemon=True).start(); servers.append(s)

def api(method, path, body=None, raw=False, status=False, headers=None):
  h = {'content-type': 'application/json', 'accept-encoding': 'gzip'}; h.update(headers or {})
  req = urllib.request.Request(HUB + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
  try:
    with urllib.request.urlopen(req, timeout=60) as r:
      data = r.read()
      if r.headers.get('content-encoding') == 'gzip': data = gzip.decompress(data)
      if status: return r.status, data.decode()[:300]
      if raw: return data.decode()
      t = data.decode(); return json.loads(t) if t else None
  except urllib.error.HTTPError as e:
    if status: return e.code, e.read().decode()[:300]
    raise RuntimeError('%s %s: %s %s' % (method, path, e.code, e.read().decode()[:600]))

P = 'secrev-%d' % int(time.time())
api('POST', '/api/projects', {'name': 'Sec review', 'slug': P, 'settings': {'appOrigins': [APP]}})
bundle = {'format': 'stubyard-storyboards', 'version': 1, 'users': [{'email': 'ada@example.test', 'name': 'Ada', 'role': 'admin', 'password': 'pw-123456'}],
  'storyboards': [{'slug': 'recorded', 'name': 'Recorded', 'record': 'dom', 'recordPrivacy': {'unmaskSelectors': ['input']}, 'actors': [{'key': 'ada', 'role': 'admin', 'user': 'ada@example.test'}],
                   'steps': [{'kind': 'instruction', 'title': 'Step %d title' % i, 'intent': 'x'} for i in (1, 2)]}]}
api('POST', '/api/projects/%s/storyboards/import' % P, {'bundle': bundle})
def start(): return api('POST', '/api/projects/%s/walkthroughs' % P, {'storyboard': 'recorded', 'origin': APP, 'mode': 'tracked'})
W = start(); WID = W['id']
def wp(wid, suffix=''): return '/api/projects/%s/walkthroughs/%s%s' % (P, wid, suffix)
def rec(wid=None): return api('GET', wp(wid or WID, '/recording'))
def seg_raw(no, wid=None): return api('GET', wp(wid or WID, '/recording/segments/%d' % no), raw=True)
def allraw(wid=None): return {s['no']: seg_raw(s['no'], wid) for s in rec(wid)['segments']}

r1, w1 = os.pipe(); r2, w2 = os.pipe()
def pre():
  a = fcntl.fcntl(r1, fcntl.F_DUPFD, 20); b = fcntl.fcntl(w2, fcntl.F_DUPFD, 20); os.dup2(a, 3); os.dup2(b, 4)
prof = tempfile.mkdtemp(prefix='prof-', dir=OUT)
args = ['google-chrome', '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + prof, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank']
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
    except Exception as e: last = e
    time.sleep(step)
  raise AssertionError('timed out: %r' % (last,))
R = {}
def note(k, v):
  R[k] = v; print('RESULT', k, json.dumps(v, ensure_ascii=False)[:1500], flush=True)
def section(name, fn):
  try: fn()
  except Exception:
    note(name + ' CRASHED', traceback.format_exc()[-1500:])

try:
  ext = send('Extensions.loadUnpacked', {'path': DIST})['id']
  PANEL = 'chrome-extension://%s/sidepanel.html' % ext
  def attach(t):
    s = send('Target.attachToTarget', {'targetId': t, 'flatten': True})['sessionId']; send('Runtime.enable', {}, s); send('Page.enable', {}, s); return s
  ct = send('Target.createTarget', {'url': PANEL, 'newWindow': True})['targetId']; time.sleep(1); cs = attach(ct)
  def cx(expr): return ev(cs, expr)
  cx('chrome.storage.local.set({apiUrl: %s, widgetHintSeen: true})' % json.dumps(HUB))
  pt = send('Target.createTarget', {'url': APP + '/plain', 'newWindow': True})['targetId']; ps = attach(pt)
  time.sleep(1)
  tab = json.loads(cx('chrome.tabs.query({url: "%s/*"}).then(t => JSON.stringify({id: t[0].id, w: t[0].windowId}))' % APP))
  WINID = tab['w']
  def set_active(wid): cx('chrome.storage.local.set({activeWalkthroughByWindow: {[%d]: %s}})' % (WINID, json.dumps({'project': P, 'id': wid, 'origins': [APP]})))
  set_active(WID)
  def nav(url, wait=2.5):
    send('Page.navigate', {'url': url}, ps); time.sleep(wait)
  def typ(focus_expr, text, delay=0.05):
    ev(ps, focus_expr + '.focus()')
    for ch in text:
      send('Input.insertText', {'text': ch}, ps); time.sleep(delay)
  def q(sel): return 'document.querySelector(%s)' % json.dumps(sel)
  def mouse(n=10):
    for i in range(n):
      send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': 80 + i * 9, 'y': 120 + i * 5}, ps); time.sleep(0.03)

  def leaks():
    nav(APP + '/leak?reset_token=' + S['URLTOK'], 3)
    wait_for(lambda: rec()['segmentCount'] >= 1 and any('/leak' in s['url'] for s in rec()['segments']), 15)
    typ(q('#pw'), S['TGL_A']); ev(ps, q('#show') + '.click()'); time.sleep(0.3); typ(q('#pw'), S['TGL_B'])
    typ(q('#pw2'), S['SWAP']); ev(ps, q('#swap') + '.click()'); time.sleep(0.3)
    for i, d in enumerate(DIGITS): typ('document.querySelectorAll("#digits .d")[%d]' % i, d)
    typ(q('#otpname'), S['OTPNAME'])
    typ(q('#card'), S['CARD']); typ(q('#pwtext'), S['PWTEXT']); typ(q('#apikey'), S['APIKEY']); typ(q('#ctl'), S['CTL'])
    typ(q('#ce'), S['CE'])
    typ('document.querySelector("#sh").shadowRoot.querySelector("#spw")', S['SHADOWPW'])
    ev(ps, q('#fr') + '.focus()'); typ('document.querySelector("#fr").contentDocument.querySelector("#ipw")', S['IFRAMEPW'])
    typ(q('#note'), S['PLAIN'])
    typ(q('#pw4'), S['PAUSEDPW'])
    mouse(); time.sleep(6.5)
    raw = '\n'.join(allraw().values())
    note('leak.matrix (True = secret present in stored recording)', {k: (v in raw) for k, v in S.items() if k not in ('RACE', 'MA_PLAIN', 'MA_CE', 'PAUSEDPW')})
    evs = [json.loads(l) for l in raw.splitlines() if l.strip()]
    texts = [e['data'].get('text') for e in evs if e['type'] == 3 and e['data'].get('source') == 5]
    note('leak.input_event_texts', texts)
    note('leak.digits_in_clear', [t for t in texts if t in list(DIGITS)])
    note('leak.segment_urls', [s['url'] for s in rec()['segments']])
    # pause, toggle show on pw4 while paused, resume -> new full snapshot
    api('PATCH', wp(WID, '/recording'), {'paused': True}); time.sleep(3)
    ev(ps, q('#show4') + '.click()'); time.sleep(0.5)
    n = rec()['segmentCount']
    api('PATCH', wp(WID, '/recording'), {'paused': False})
    wait_for(lambda: rec()['segmentCount'] > n, 15); mouse(); time.sleep(6.5)
    raw2 = '\n'.join(allraw().values())
    note('leak.password shown while paused then resumed', S['PAUSEDPW'] in raw2)
    # pause race: PATCH paused via hub API then type at once into a plain field
    ev(ps, q('#note') + '.value=""')
    api('PATCH', wp(WID, '/recording'), {'paused': True})
    typ(q('#note'), S['RACE'], 0.1)
    time.sleep(7)
    raw3 = '\n'.join(allraw().values())
    evs3 = [json.loads(l) for l in raw3.splitlines() if l.strip()]
    t3 = [e['data'].get('text') for e in evs3 if e['type'] == 3 and e['data'].get('source') == 5 and str(e['data'].get('text', '')).startswith('RACE')]
    note('pause.race typed-after-pause text stored (longest)', max(t3, key=len) if t3 else None)
    # chunks accepted by the server while paused?
    note('pause.server accepts chunk while paused', api('POST', wp(WID, '/recording/chunks'), {'segment': {'key': 'pausedforge1'}, 'seq': 0, 'events': [{'type': 5, 'timestamp': int(time.time() * 1000), 'data': {'tag': 'x', 'payload': 'sent-while-paused'}}]}, status=True))
    n = rec()['segmentCount']
    api('PATCH', wp(WID, '/recording'), {'paused': False, 'maskAllInputs': True})
    wait_for(lambda: rec()['segmentCount'] > n, 15)
    typ(q('#ma'), S['MA_PLAIN']); ev(ps, q('#ce') + '.textContent=""'); typ(q('#ce'), S['MA_CE']); mouse(); time.sleep(6.5)
    segs = rec()['segments']; last = seg_raw(segs[-1]['no'])
    note('maskAll.last segment', {'plain input leaked': S['MA_PLAIN'] in last, 'contenteditable leaked': S['MA_CE'] in last, 'hidden input leaked': S['HIDDEN'] in last, 'page text (TOTP seed) leaked': S['TOTPTEXT'] in last, 'url token': S['URLTOK'] in last})
  section('leaks', leaks)

  def big():
    w2 = start()['id']; set_active(w2); time.sleep(0.5)
    nav(APP + '/big', 6); mouse(); time.sleep(8)
    l = rec(w2)
    note('big.page (9 MB DOM) recording', {'segments': l['segmentCount'], 'bytes': l['bytes'], 'stopped': l['stopped'], 'mode': l['mode']})
    notes = [json.loads(x) for raw in allraw(w2).values() for x in raw.splitlines() if '"stubyard.note"' in x]
    note('big.notes', [n['data']['payload'].get('reason') for n in notes])
    nav(APP + '/plain', 3); typ(q('#note'), 'after-big'); mouse(); time.sleep(7)
    l = rec(w2)
    note('big.after navigating to a small page', {'segments': [(s['url'], s['events']) for s in l['segments']], 'stopped': l['stopped']})
  section('big', big)

  def server():
    w3 = start()['id']
    t0 = time.time()
    codes = set()
    for i in range(400):
      codes.add(api('POST', wp(w3, '/recording/chunks'), {'segment': {'key': 'empty%d' % i, 'url': 'http://x/'}, 'seq': 0, 'events': []}, status=True)[0])
    l = rec(w3)
    note('server.empty chunks create segments', {'codes': sorted(codes), 'segments': l['segmentCount'], 'bytes': l['bytes'], 'maxBytes': l['maxBytes'], 'secs': round(time.time() - t0, 1)})
    ts = int(time.time() * 1000)
    evs = [{'type': 5, 'timestamp': ts, 'data': {'tag': 'x', 'payload': 'A' * 150}} for _ in range(38000)]
    t0 = time.time(); st = api('POST', wp(w3, '/recording/chunks'), {'segment': {'key': 'bomb'}, 'seq': 0, 'events': evs}, status=True)
    l = rec(w3); seg = [s for s in l['segments'] if s['events'] == 38000]
    rawlen = len(seg_raw(seg[0]['no'], w3)) if seg else None
    note('server.compressible chunk', {'status': st[0], 'storedBytes': seg[0]['bytes'] if seg else None, 'rawBytes': rawlen, 'countedRawBytes': seg[0].get('rawBytes') if seg else None, 'postSecs': round(time.time() - t0, 2)})
    st = api('POST', wp(w3, '/recording/chunks'), {'segment': {'key': 'uni', 'url': 'http://x/✓'}, 'seq': 0, 'events': [{'type': 4, 'timestamp': ts, 'data': {}}]}, status=True)
    no = [s['no'] for s in rec(w3)['segments'] if s['url'].endswith('✓') or s['url'].endswith('%E2%9C%93')]
    note('server.non-latin1 segment url', {'post': st[0], 'get': api('GET', wp(w3, '/recording/segments/%d' % no[0]), status=True) if no else None})
    # finished run still takes chunks?
    w4 = start()['id']
    ab = api('POST', wp(w4, '/abandon'), {'note': 'x'}, status=True)
    st = api('POST', wp(w4, '/recording/chunks'), {'segment': {'key': 'afterend'}, 'seq': 0, 'events': [{'type': 4, 'timestamp': ts, 'data': {}}]}, status=True)
    note('server.chunk after abandon', {'abandon': ab[0], 'status': api('GET', wp(w4))['status'], 'post': st})
    # cross-site guard on the new routes
    note('server.guard', {'POST foreign origin': api('POST', wp(w3, '/recording/chunks'), {'segment': {'key': 'g'}, 'seq': 0, 'events': []}, status=True, headers={'Origin': 'http://evil.example'})[0],
                          'POST same-host other port origin (app under test)': api('POST', wp(w3, '/recording/chunks'), {'segment': {'key': 'g2'}, 'seq': 0, 'events': []}, status=True, headers={'Origin': APP})[0],
                          'DELETE same-host other port origin': api('DELETE', wp(w4, '/recording'), None, status=True, headers={'Origin': APP})[0],
                          'GET bad host': api('GET', wp(w3, '/recording'), status=True, headers={'Host': 'evil.example'})[0]})
    R['w3'] = w3
  section('server', server)

  def player():
    w5 = start()['id']; ts = int(time.time() * 1000) - 5000
    ids = [100]
    def nid():
      ids[0] += 1; return ids[0]
    def el(tag, attrs=None, kids=None, **kw):
      d = {'type': 2, 'tagName': tag, 'attributes': attrs or {}, 'childNodes': kids or [], 'id': nid()}; d.update(kw); return d
    def tx(t): return {'type': 3, 'textContent': t, 'id': nid()}
    T = OTHER
    evil = [
      el('script', {}, [tx('top.__xss=(top.__xss||"")+"|script"')]),
      el('img', {'src': 'x', 'onerror': 'top.__xss=(top.__xss||"")+"|onerror"'}),
      el('svg', {}, [el('script', {}, [tx('top.__xss=(top.__xss||"")+"|svgscript"')], isSVG=True)], isSVG=True),
      el('iframe', {'srcdoc': '<script>top.__xss=(top.__xss||"")+"|srcdoc"</script>', 'sandbox': 'allow-scripts allow-same-origin'}),
      el('iframe', {'src': 'javascript:top.__xss=(top.__xss||"")+"|jsiframe"'}),
      el('iframe', {'src': T + '/frame.html'}),
      el('object', {'data': T + '/object.html'}),
      el('embed', {'src': T + '/embed.html'}),
      el('img', {'src': T + '/pixel.png?viewer=1'}),
      el('link', {'rel': 'stylesheet', 'href': T + '/track.css'}),
      el('style', {}, [tx('body{background:url(%s/bg.png)} @import url(%s/import.css);' % (T, T))]),
      el('meta', {'http-equiv': 'refresh', 'content': '0;url=%s/refresh.html' % T}),
      el('a', {'href': 'javascript:top.__xss="|jslink"', 'id': 'jl'}, [tx('link')]),
      el('body', {'onload': 'top.__xss=(top.__xss||"")+"|bodyonload"'}),
      el('video', {'src': T + '/video.mp4', 'autoplay': ''}),
      el('input', {'autofocus': '', 'onfocus': 'top.__xss=(top.__xss||"")+"|onfocus"'}),
    ]
    body = el('body', {}, [el('h1', {}, [tx('forged page')])] + evil)
    html = el('html', {}, [el('head', {}, []), body])
    doc = {'type': 0, 'childNodes': [{'type': 1, 'name': 'html', 'publicId': '', 'systemId': '', 'id': nid()}, html], 'id': 1}
    late = el('img', {'src': T + '/late.png', 'onerror': 'top.__xss=(top.__xss||"")+"|late-onerror"'})
    events = [{'type': 4, 'timestamp': ts, 'data': {'href': 'http://app.test/', 'width': 800, 'height': 600}},
              {'type': 2, 'timestamp': ts + 1, 'data': {'node': doc, 'initialOffset': {'left': 0, 'top': 0}}},
              {'type': 3, 'timestamp': ts + 500, 'data': {'source': 0, 'texts': [], 'attributes': [{'id': body['id'], 'attributes': {'onclick': 'top.__xss="|attr-onclick"'}}], 'removes': [], 'adds': [{'parentId': body['id'], 'nextId': None, 'node': late}]}},
              {'type': 5, 'timestamp': ts + 2000, 'data': {'tag': 'stubyard.step', 'payload': {'stepId': '<img src=x onerror=top.__xss="|stepid">'}}},
              {'type': 3, 'timestamp': ts + 3000, 'data': {'source': 1, 'positions': [{'x': 1, 'y': 1, 'id': body['id'], 'timeOffset': 0}]}}]
    st = api('POST', wp(w5, '/recording/chunks'), {'segment': {'key': 'forged', 'url': 'javascript:alert(1)//"><img src=x onerror=top.__xss="|segurl">'}, 'seq': 0, 'events': events, 'final': True}, status=True)
    dt = send('Target.createTarget', {'url': 'about:blank', 'newWindow': True})['targetId']; ds = attach(dt)
    send('Emulation.setDeviceMetricsOverride', {'width': 1280, 'height': 1000, 'deviceScaleFactor': 1, 'mobile': False}, ds)
    send('Page.navigate', {'url': '%s/p/%s/storyboards?tab=walkthroughs&wt=%s' % (HUB, P, w5)}, ds)
    wait_for(lambda: ev(ds, '!!document.querySelector(".drawer")'), 12)
    try: wait_for(lambda: ev(ds, '!![...document.querySelectorAll(".drawer .seg-btn")].find(b => b.textContent.startsWith("Recording"))'), 12)
    except AssertionError: raise AssertionError('no Recording tab: %r' % (ev(ds, 'location.href + " | " + (document.querySelector(".drawer")?.innerText || "").slice(0, 600)'),))
    ev(ds, '[...document.querySelectorAll(".drawer .seg-btn")].find(b => b.textContent.startsWith("Recording")).click()')
    RF = 'document.querySelector("iframe.rec-host")?.contentDocument?.querySelector("iframe")'
    wait_for(lambda: ev(ds, '!!' + RF), 15)
    wait_for(lambda: ev(ds, '!document.querySelector(".rec-play").disabled'), 10)
    ev(ds, 'document.querySelector(".rec-play").click()'); time.sleep(5)
    info = ev(ds, '''(() => { const host = document.querySelector("iframe.rec-host"); const f = host.contentDocument.querySelector("iframe"); const d = f.contentDocument; return JSON.stringify({
      hostSrc: host.getAttribute("src"), hostSandbox: host.getAttribute("sandbox"),
      sandbox: f.getAttribute("sandbox"), xss: window.__xss || null, location: location.href.slice(0, 80), innerHref: (() => { try { return d.location.href } catch (e) { return "err" } })(),
      scripts: d.querySelectorAll("script").length, noscripts: d.querySelectorAll("noscript").length,
      attrs: [...d.querySelectorAll("*")].flatMap(e => [...e.attributes].filter(a => /^on|^_on|srcdoc|^src$|^href$|http-equiv|^data$|sandbox|rr_/.test(a.name)).map(a => e.tagName + " " + a.name + "=" + a.value.slice(0, 60))),
      csp: document.querySelector("meta[http-equiv=Content-Security-Policy]")?.content || null }) })()''')
    note('player.inspect', json.loads(info))
    hdr = None
    try:
      with urllib.request.urlopen(HUB + wp(w5, '/recording/player'), timeout=10) as r: hdr = {k.lower(): v for k, v in r.headers.items() if k.lower() in ('content-security-policy', 'x-frame-options', 'referrer-policy')}
    except Exception as e: hdr = str(e)
    note('player.replay page response headers (csp etc.)', hdr)
    time.sleep(1)
    note('player.remote requests made by the viewer browser', HITS)
    note('player.post', st)
  section('player', player)
finally:
  json.dump(R, open(os.path.join(OUT, 'results.json'), 'w'), indent=1)
  try: proc.terminate()
  except Exception: pass
  for s in servers: s.shutdown()

# ---- The checks: every leak the review found must be closed ----
FAILS = []
def check(name, ok, detail=None):
  if not ok: FAILS.append(name)
  print(('PASS ' if ok else 'FAIL ') + name + ('' if detail is None else '  ' + json.dumps(detail, ensure_ascii=False)[:400]), flush=True)
for k in [k for k in R if k.endswith('CRASHED')]: check(k, False, R[k][-300:])
m = R.get('leak.matrix (True = secret present in stored recording)') or {}
check('every secret field stays masked although the storyboard unmasks inputs', bool(m) and not any(v for k, v in m.items() if k != 'PLAIN'), {k: v for k, v in m.items() if v and k != 'PLAIN'})
check('the unmask list shows a plain field', m.get('PLAIN') is True)
check('split one-time code boxes: no digit in clear', R.get('leak.digits_in_clear') == [], R.get('leak.digits_in_clear'))
check('segment URLs carry no token', not any(S['URLTOK'] in u for u in R.get('leak.segment_urls') or ['?' + S['URLTOK']]), R.get('leak.segment_urls'))
check('a password shown while paused is masked in the next segment', R.get('leak.password shown while paused then resumed') is False)
check('nothing typed after a pause is stored', R.get('pause.race typed-after-pause text stored (longest)') is None)
pc = R.get('pause.server accepts chunk while paused') or [0, '']
check('the hub keeps nothing sent while paused', pc[0] == 409 or '"stored":false' in pc[1], pc)
ma = R.get('maskAll.last segment') or {'missing': True}
check('strict masking: inputs, contenteditable, hidden inputs, page text and URL tokens', not any(ma.values()), ma)
bn = R.get('big.notes') or []
check('a 9 MB page: the segment says why it is not recorded', any('not recorded' in (n or '') for n in bn), bn)
ba = R.get('big.after navigating to a small page') or {}
check('the next page records again', any('/plain' in u and n > 0 for u, n in ba.get('segments', [])), ba)
ec = R.get('server.empty chunks create segments') or {}
check('empty chunks create no segments', ec.get('segments') == 0, ec)
cc = R.get('server.compressible chunk') or {}
# The review's chunk (8.3 MB uncompressed, 38 KB gzip) fits the 8 MiB chunk cap: it is accepted, and its uncompressed size
# counts against the per-segment (32 MB) and per-walkthrough (10x the MB cap) uncompressed limits.
check('a highly compressible chunk: its uncompressed size is counted (or it is refused)', cc.get('status') == 413 or (cc.get('countedRawBytes') or 0) >= (cc.get('rawBytes') or 1), cc)
nl = R.get('server.non-latin1 segment url') or {}
check('a non-latin URL: the segment downloads (no 500)', nl.get('post') == 201 and (nl.get('get') or [0])[0] == 200, nl)
ab = R.get('server.chunk after abandon') or {}
check('a chunk after the run ended is refused (409)', (ab.get('post') or [0])[0] == 409, ab)
g = R.get('server.guard') or {}
check('cross-site writes and a bad Host are refused', g.get('POST foreign origin') == 403 and g.get('GET bad host') == 403, g)
pi = R.get('player.inspect') or {}
check('replay: no script of the recording ran', pi.get('xss') is None and pi.get('scripts') == 0, {'xss': pi.get('xss'), 'scripts': pi.get('scripts')})
check('replay: in the hub replay page, sandboxed', '/recording/player' in (pi.get('hostSrc') or '') and pi.get('hostSandbox') == 'allow-same-origin', {'src': pi.get('hostSrc'), 'sandbox': pi.get('hostSandbox')})
check('replay: no request reached another site', R.get('player.remote requests made by the viewer browser') == [], R.get('player.remote requests made by the viewer browser'))
h = R.get('player.replay page response headers (csp etc.)') or {}
csp = h.get('content-security-policy', '') if isinstance(h, dict) else ''
check('replay page: strict CSP and no referrer', "default-src 'none'" in csp and "script-src 'none'" in csp and h.get('referrer-policy') == 'no-referrer', h)
print('%d check(s) failed' % len(FAILS) if FAILS else 'all checks passed', flush=True)
sys.exit(1 if FAILS else 0)
