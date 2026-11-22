#!/usr/bin/env python3
# Floating-widget spike (docs/design/floating-widget.md, "Spike"): host Google Chrome (headless, CDP over
# --remote-debugging-pipe, Extensions.loadUnpacked) + small Python fixture servers on ports 41801-41805.
# Not part of npm test. Run from anywhere:  python3 -I packages/extension/test/widget-spike/guard.py [LAN-IP]   (first: build the extension and copy packages/extension/dist to ./dist-a)
# Needs: google-chrome >= 126, openssl, python3. Before the first run:
#   openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem -out certs/cert.pem -days 30 -subj /CN=localhost \
#     -addext subjectAltName=DNS:localhost,IP:127.0.0.1        (inside this directory; certs/ is not committed)
#   fixtures/radix.js (the real @radix-ui/react-dialog fixture) is not committed either: bundle fixtures/radix-app.jsx
#   with react, react-dom, @radix-ui/react-dialog and esbuild in a throwaway folder (see the design doc).
# The Chrome profile and results.json go to a temp folder (or $SPIKE_OUT); nothing is written here.
# The built extension: content-script re-inject guard across an extension reload, and widget.suspend/resume with a real
# captureVisibleTab.
import os, sys, json, time, threading, ssl, subprocess, http.server, socketserver, fcntl, traceback, tempfile
WS = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(WS, 'fixtures')
LAN = sys.argv[1] if len(sys.argv) > 1 else '192.168.0.126'
HUBLOG = []
CSP_STRICT = "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; img-src 'self'"
PAGES = {
  'plain': {}, 'csp': {'Content-Security-Policy': CSP_STRICT}, 'csp-none': {'Content-Security-Policy': "default-src 'none'; script-src 'self'"},
  'coep': {'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin'},
  'coep-cl': {'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Opener-Policy': 'same-origin'},
  'pp-clip': {'Permissions-Policy': 'clipboard-write=()'},
  'xfo': {'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'"},
  'dialog': {}, 'radix': {},
}
BODY = {
  'dialog': '<dialog id="d"><p>Native modal dialog</p><input id="dlg-in"></dialog><script src="/dialog.js"></script>',
  'radix': '<div id="root"></div><script src="/radix.js"></script>',
}
class Fix(http.server.BaseHTTPRequestHandler):
  def log_message(self, *a): pass
  def do_GET(self):
    path = self.path.split('?')[0]
    if path.startswith('/p/'):
      name = path[3:]
      if name not in PAGES: return self.send_error(404)
      body = ('<!doctype html><html><head><meta charset="utf-8"><title>%s</title></head><body><h1>Fixture %s</h1><form><label>Name <input name="name"></label><button type="submit">Submit</button></form>%s<script src="/probe.js"></script></body></html>' % (name, name, BODY.get(name, ''))).encode()
      self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
      for k, v in PAGES[name].items(): self.send_header(k, v)
      self.end_headers(); self.wfile.write(body); return
    f = os.path.join(FIX, os.path.basename(path))
    if os.path.isfile(f):
      data = open(f, 'rb').read(); self.send_response(200); self.send_header('Content-Type', 'text/javascript')
      self.send_header('Cross-Origin-Resource-Policy', 'same-origin'); self.end_headers(); self.wfile.write(data); return
    self.send_error(404)
class Hub(http.server.BaseHTTPRequestHandler):
  protocol_version = 'HTTP/1.1'
  def log_message(self, *a): pass
  def rec(self):
    HUBLOG.append({'path': self.path, 'method': self.command, 'origin': self.headers.get('Origin'), 'sfs': self.headers.get('Sec-Fetch-Site'), 'host': self.headers.get('Host'), 'mode': self.headers.get('Sec-Fetch-Mode'), 'dest': self.headers.get('Sec-Fetch-Dest')})
  def js(self, o):
    b = json.dumps(o).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
  def do_OPTIONS(self):
    self.rec(); self.send_response(204); self.send_header('Content-Length', '0'); self.end_headers()
  def do_GET(self):
    self.rec()
    if self.path.startswith('/sse'):
      self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control', 'no-cache'); self.end_headers()
      try:
        self.wfile.write(b'data: hello\n\n'); self.wfile.flush(); time.sleep(1.5)
      except Exception: pass
      self.close_connection = True; return
    self.js({'ok': True, 'origin': self.headers.get('Origin'), 'sfs': self.headers.get('Sec-Fetch-Site')})
  def do_POST(self):
    self.rec(); n = int(self.headers.get('Content-Length') or 0); self.rfile.read(n); self.js({'ok': True, 'origin': self.headers.get('Origin')})
class TS(socketserver.ThreadingMixIn, http.server.HTTPServer): daemon_threads = True; allow_reuse_address = True
def serve(handler, host, port, tls=False):
  s = TS((host, port), handler)
  if tls:
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(os.path.join(WS, 'certs/cert.pem'), os.path.join(WS, 'certs/key.pem')); s.socket = c.wrap_socket(s.socket, server_side=True)
  threading.Thread(target=s.serve_forever, daemon=True).start(); return s
servers = [serve(Fix, '127.0.0.1', 41801), serve(Fix, '127.0.0.1', 41802, True), serve(Fix, '127.0.0.1', 41804), serve(Fix, '127.0.0.1', 41805, True),
           serve(Hub, '127.0.0.1', 41803), serve(Hub, LAN, 41803)]

# ---- CDP over pipe ----
r1, w1 = os.pipe(); r2, w2 = os.pipe()
def pre():
  a = fcntl.fcntl(r1, fcntl.F_DUPFD, 20); b = fcntl.fcntl(w2, fcntl.F_DUPFD, 20)
  os.dup2(a, 3); os.dup2(b, 4)
OUT = os.environ.get('SPIKE_OUT') or tempfile.mkdtemp(prefix='stubyard-spike-'); prof = os.path.join(OUT, 'prof')
args = ['google-chrome', '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', '--user-data-dir=' + prof,
        '--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors', '--window-size=1280,800',
        '--ip-address-space-overrides=127.0.0.1:41804=public,127.0.0.1:41805=public', 'about:blank']
proc = subprocess.Popen(args, preexec_fn=pre, close_fds=False, stdout=subprocess.DEVNULL, stderr=open(os.path.join(OUT, 'chrome.log'), 'w'))
os.close(r1); os.close(w2)
out = os.fdopen(w1, 'wb', buffering=0); inp = os.fdopen(r2, 'rb', buffering=0)
buf = b''; mid = 0; events = []
lock = threading.Lock()
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
    events.append(msg)
def ev(session, expr, await_=True):
  r = send('Runtime.evaluate', {'expression': expr, 'awaitPromise': await_, 'returnByValue': True}, session)
  return r.get('result', {}).get('value', r.get('exceptionDetails', {}).get('text'))
def load(path):
  return send('Extensions.loadUnpacked', {'path': path})['id']

R = {}
try:
  ext = load(os.path.join(WS, 'dist-a')); R['id'] = ext
  def attach(t):
    s = send('Target.attachToTarget', {'targetId': t, 'flatten': True})['sessionId']; send('Runtime.enable', {}, s); return s
  page_t = send('Target.createTarget', {'url': 'http://127.0.0.1:41801/p/plain?nowidget'})['targetId']; ps = attach(page_t)
  def ctl():
    t = send('Target.createTarget', {'url': 'chrome-extension://%s/sidepanel.html' % ext, 'newWindow': True})['targetId']; time.sleep(1.5); return attach(t)
  time.sleep(1.5); cs = ctl()
  tab = json.loads(ev(cs, 'chrome.tabs.query({url: "http://127.0.0.1:41801/*"}).then(t => JSON.stringify({id: t[0].id, w: t[0].windowId}))'))
  TID, WID = tab['id'], tab['w']
  JS = r'''
  window.X = async (what) => {
    const tabId = %d, windowId = %d;
    const exec = (func) => chrome.scripting.executeScript({ target: { tabId }, func }).then((r) => r[0].result);
    const ping = () => chrome.tabs.sendMessage(tabId, { type: 'ping' }).then((r) => r, (e) => 'ERR ' + e.message);
    const px = async () => { const d = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }); const bm = await createImageBitmap(await (await fetch(d)).blob()); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext('2d'); g.drawImage(bm, 0, 0); const p = g.getImageData(bm.width - 60, bm.height - 60, 1, 1).data; return [p[0], p[1], p[2]].join(','); };
    if (what === 'state') return JSON.stringify({ marker: await exec(() => { const m = window.__stubyardContent; return m === undefined ? 'none' : typeof m === 'string' ? m : { version: m.version, alive: (() => { try { return m.alive(); } catch (e) { return 'throws'; } })() }; }), ping: await ping() });
    if (what === 'inject') { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return JSON.stringify({ ping: await ping() }); }
    if (what === 'shot') { const z = () => new Promise((r) => setTimeout(r, 700)); const o = { before: await px() }; await z(); o.suspend = await chrome.tabs.sendMessage(tabId, { type: 'widget.suspend' }); o.hidden = await px(); await z(); o.resume = await chrome.tabs.sendMessage(tabId, { type: 'widget.resume' }); await z(); o.after = await px(); return JSON.stringify(o); }
  }; 'ok'
  ''' % (TID, WID)
  ev(cs, JS)
  R['1_before'] = ev(cs, 'X("state")')
  R['2_inject'] = ev(cs, 'X("inject")')
  R['3_inject_again'] = ev(cs, 'X("inject")')
  R['4_state'] = ev(cs, 'X("state")')
  ev(ps, 'const d = document.createElement("div"); d.setAttribute("data-stubyard-widget", "1"); d.style.cssText = "position:fixed;right:0;bottom:0;width:200px;height:200px;background:#f0f;z-index:2147483647"; document.documentElement.append(d); "ok"')
  time.sleep(0.3)
  r5 = send('Runtime.evaluate', {'expression': 'X("shot").catch(e => "ERR " + e.message)', 'awaitPromise': True, 'returnByValue': True}, cs)
  R['5_shot'] = r5
  # reload the extension (same path, same id): the old content script is orphaned
  load(os.path.join(WS, 'dist-a')); time.sleep(1.5)
  cs = ctl(); ev(cs, JS)
  R['6_after_reload_state'] = ev(cs, 'X("state")')
  R['7_hostStillThere'] = ev(ps, '!!document.querySelector("[data-stubyard-widget]")')
  R['8_reinject'] = ev(cs, 'X("inject")')
  R['9_state'] = ev(cs, 'X("state")')
  R['10_hostRemoved'] = ev(ps, '!document.querySelector("[data-stubyard-widget]")')
except Exception as e:
  R['error'] = traceback.format_exc()
finally:
  try: send('Browser.close')
  except Exception: pass
  time.sleep(0.5); proc.kill()
  for s in servers: s.shutdown()
print(json.dumps(R, indent=1))
