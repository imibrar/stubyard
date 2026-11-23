#!/usr/bin/env node
/**
 * Fill a running stubyard with sample traffic for the projects in samples/seed (see samples/README.md).
 *
 *   node samples/populate.mjs [--api http://127.0.0.1:4000] [--smtp 127.0.0.1:1025] [--again]
 *
 * Everything goes through stubyard's real endpoints, the way an app would send it: SMTP, the SendGrid / Mailgun / SES
 * APIs, Twilio / Vonage / generic SMS, the WhatsApp Cloud API, FCM and APNs, Stripe / PayPal / PayTabs, the fake
 * OAuth providers, S3 uploads, webhooks, API mocks and the mock LLM APIs. Plain Node 18+, no dependencies.
 *
 * Idempotent-ish: when the main project already has messages it stops, unless --again adds another round.
 */
import crypto from 'node:crypto';
import net from 'node:net';

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node samples/populate.mjs [--api http://127.0.0.1:4000] [--smtp 127.0.0.1:1025] [--again]');
  process.exit(0);
}
// 127.0.0.1 rather than localhost: Node may resolve localhost to ::1, and the dev container only listens on IPv4.
const API = opt('api', 'http://127.0.0.1:4000').replace(/\/+$/, '');
const [SMTP_HOST, SMTP_PORT] = (() => {
  const raw = opt('smtp', '127.0.0.1:1025').replace(/^smtp:\/\//, '');
  const i = raw.lastIndexOf(':');
  return i > 0 ? [raw.slice(0, i), Number(raw.slice(i + 1))] : [raw, 1025];
})();
const AGAIN = argv.includes('--again');

const PROJECTS = ['brightpath', 'ledgerline', 'souk', 'sandbox'];
const APP = 'http://localhost:3000'; // the fake app under test: only appears in links

// ---------------------------------------------------------------- tiny helpers
const stats = {};
const problems = [];
const count = (k, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code6 = () => String(crypto.randomInt(100000, 1000000));
const pick = (a) => a[crypto.randomInt(a.length)];
const token = (n = 24) => crypto.randomBytes(n).toString('base64url');
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** fetch + JSON; never throws on HTTP errors (traffic with 4xx is part of the sample), only on network errors. */
async function call(method, url, { json, form, headers = {}, raw, redirect } = {}) {
  const h = { ...headers };
  let body = raw;
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    h['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url.startsWith('http') ? url : API + url, { method, headers: h, body, redirect: redirect ?? 'follow' });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}
/** Control API call that must succeed. */
async function api(method, path, json) {
  const r = await call(method, path, { json });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`.slice(0, 400));
  return r.data;
}
/** Run one step; a failure is reported but does not stop the rest. */
async function step(label, fn) {
  try {
    await fn();
  } catch (e) {
    problems.push(`${label}: ${e.message}`);
    console.log(`  ! ${label}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- SMTP (node:net, no TLS, AUTH PLAIN)
class Smtp {
  static async open(user) {
    const s = new Smtp();
    await s.connect();
    await s.expect(null, 220);
    const ehlo = await s.cmd('EHLO populate.example.test', 250);
    if (/AUTH/i.test(ehlo.text)) await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0sample`).toString('base64')}`, 235);
    return s;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.buf = '';
      this.waiters = [];
      this.sock = net.connect(SMTP_PORT, SMTP_HOST, resolve);
      this.sock.setEncoding('utf8');
      this.sock.on('error', reject);
      this.sock.on('data', (d) => {
        this.buf += d;
        this.flush();
      });
    });
  }
  flush() {
    // A reply is complete at a line "NNN text" (no dash after the code).
    for (;;) {
      const m = /^((?:\d{3}-.*\r?\n)*)(\d{3})(?: .*)?\r?\n/.exec(this.buf);
      if (!m || !this.waiters.length) return;
      this.buf = this.buf.slice(m[0].length);
      this.waiters.shift()({ code: Number(m[2]), text: m[0] });
    }
  }
  read() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.flush();
    });
  }
  async expect(line, ok) {
    if (line !== null) this.sock.write(line + '\r\n');
    const r = await this.read();
    if (ok && r.code !== ok) throw Object.assign(new Error(`SMTP ${line ?? 'greeting'} → ${r.text.trim()}`), { smtp: r });
    return r;
  }
  cmd(line, ok) {
    return this.expect(line, ok);
  }
  /** Send one email. Returns 'sent' or 'rejected' (a rule refused the recipient, which is part of the sample). */
  async send({ from, to, subject, text, html, headers = {} }) {
    await this.cmd(`MAIL FROM:<${from.replace(/.*</, '').replace(/>.*/, '')}>`, 250);
    const rcpt = await this.cmd(`RCPT TO:<${to}>`);
    if (rcpt.code >= 400) {
      await this.cmd('RSET', 250);
      return 'rejected';
    }
    await this.cmd('DATA', 354);
    const boundary = `b_${token(9)}`;
    const head = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${token(12)}@populate.example.test>`,
      'MIME-Version: 1.0',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    let body;
    if (html) {
      head.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      body = [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, `--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', html, `--${boundary}--`].join('\r\n');
    } else {
      head.push('Content-Type: text/plain; charset=utf-8');
      body = text;
    }
    const data = (head.join('\r\n') + '\r\n\r\n' + body).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const r = await this.cmd(`${data}\r\n.`);
    if (r.code >= 400) return 'rejected';
    return 'sent';
  }
  async close() {
    try {
      await this.cmd('QUIT');
    } catch {
      /* ignore */
    }
    this.sock.end();
  }
}

async function smtpBatch(user, emails) {
  const s = await Smtp.open(user);
  try {
    for (const e of emails) {
      const r = await s.send(e);
      count(r === 'sent' ? 'email (SMTP)' : 'email rejected by a rule');
    }
  } finally {
    await s.close();
  }
}

// ---------------------------------------------------------------- email builders
const htmlWrap = (brand, color, inner) =>
  `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f5f5f7;padding:24px"><table width="100%" style="max-width:560px;margin:auto;background:#fff;border-radius:8px"><tr><td style="background:${color};color:#fff;padding:16px 24px;font-size:20px;font-weight:bold">${brand}</td></tr><tr><td style="padding:24px;font-size:15px;line-height:1.5;color:#222">${inner}</td></tr><tr><td style="padding:12px 24px;font-size:12px;color:#888">You get this email because you have an account. <a href="${APP}/settings/email">Email settings</a></td></tr></table></body></html>`;

const otpEmail = (brand, color, from, to, name, c) => ({
  from,
  to,
  subject: `${c} is your ${brand} code`,
  text: `Hi ${name},\n\nYour ${brand} verification code is ${c}. It expires in 10 minutes.\n\nIf you did not ask for it, ignore this email.`,
  html: htmlWrap(brand, color, `<p>Hi ${name},</p><p>Your verification code is</p><p style="font-size:32px;letter-spacing:6px;font-weight:bold">${c}</p><p>It expires in 10 minutes.</p>`),
});
const magicEmail = (brand, color, from, to, name) => {
  const link = `${APP}/auth/magic?token=${token()}&email=${encodeURIComponent(to)}`;
  return {
    from,
    to,
    subject: `Your ${brand} sign-in link`,
    text: `Hi ${name},\n\nClick to sign in: ${link}\n\nThe link works once and expires in 15 minutes.`,
    html: htmlWrap(brand, color, `<p>Hi ${name},</p><p><a href="${link}" style="background:${color};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Sign in to ${brand}</a></p><p style="font-size:12px;color:#666">Or paste this link: ${link}</p>`),
  };
};

// ---------------------------------------------------------------- per-channel senders (real provider APIs)
const twilioSms = (p, inst, to, body, extra = {}) =>
  call('POST', `/mock/${p}/${inst}/2010-04-01/Accounts/AC00000000000000000000000000sample/Messages.json`, {
    form: { To: to, From: '+15550109000', Body: body, ...extra },
    headers: { authorization: `Basic ${Buffer.from('AC00000000000000000000000000sample:sample-token').toString('base64')}` },
  });
const vonageSms = (p, inst, to, text) => call('POST', `/mock/${p}/${inst}/sms/json`, { json: { api_key: 'sample', api_secret: 'sample', from: 'Brightpath', to: to.replace('+', ''), text } });
const metaWa = (p, inst, to, payload) =>
  call('POST', `/mock/${p}/${inst}/v21.0/100000000000001/messages`, { json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace('+', ''), ...payload }, headers: { authorization: 'Bearer EAAsample' } });

async function sms(label, fn) {
  const r = await fn();
  if (r.status >= 500) throw new Error(`${label} → ${r.status}`);
  count(r.ok ? label : `${label} (refused by a rule)`);
  return r;
}

// ---------------------------------------------------------------- push (FCM HTTP v1 and APNs over HTTP/1 path)
function jwtRs256(claims, pem, kid) {
  const head = b64url({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64url(claims);
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), pem).toString('base64url');
  return `${head}.${body}.${sig}`;
}
function jwtEs256(claims, pem, kid) {
  const head = b64url({ alg: 'ES256', kid });
  const body = b64url(claims);
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: pem, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}
async function fcmClient(p, inst) {
  const sa = await api('GET', `/api/projects/${p}/push/instances/${inst}/service-account.json`);
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwtRs256({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: sa.token_uri, iat: now, exp: now + 3600 }, sa.private_key, sa.private_key_id);
  const t = await call('POST', sa.token_uri, { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion } });
  if (!t.ok) throw new Error(`FCM token → ${t.status} ${JSON.stringify(t.data)}`);
  return async (message) => {
    const r = await call('POST', `/push/${p}/${inst}/v1/projects/${sa.project_id}/messages:send`, { json: { message }, headers: { authorization: `Bearer ${t.data.access_token}` } });
    count(r.ok ? 'push (FCM)' : 'push rejected (FCM)');
    return r;
  };
}
async function apnsClient(p, inst) {
  const c = await api('GET', `/api/projects/${p}/push/instances/${inst}/connect`);
  const key = await call('GET', `/api/projects/${p}/push/instances/${inst}/apns-key.p8`);
  const jwt = jwtEs256({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) }, key.data, c.keyId);
  return async (deviceToken, aps, extra = {}, headers = {}) => {
    const r = await call('POST', `/push/${p}/${inst}/3/device/${deviceToken}`, {
      json: { aps, ...extra },
      headers: { authorization: `bearer ${jwt}`, 'apns-topic': c.bundleIds[0], 'apns-push-type': 'alert', 'apns-priority': '10', ...headers },
    });
    count(r.ok ? 'push (APNs)' : 'push rejected (APNs)');
    return r;
  };
}

// ---------------------------------------------------------------- shared lookups
async function users(p) {
  const list = await api('GET', `/api/projects/${p}/users`);
  const by = {};
  for (const u of list) by[(u.email ?? u.phone ?? u.name).split('@')[0].split('.')[0]] = u;
  return { list, by, get: (prefix) => list.find((u) => (u.email ?? '').startsWith(prefix) || u.name.startsWith(prefix)) };
}
async function markSomeRead(p, share) {
  const msgs = await api('GET', `/api/projects/${p}/messages?limit=500`);
  // Keep the newest ones unread; mark a share of the older ones read.
  const older = msgs.slice(Math.ceil(msgs.length * 0.3));
  let n = 0;
  for (const m of older) {
    if (crypto.randomInt(100) < share * 100) {
      await api('POST', `/api/messages/${m.id}/read`);
      n++;
    }
  }
  count('messages marked read', n);
}

// ================================================================ Brightpath (consumer app, the main one)
async function brightpath() {
  const P = 'brightpath';
  const BRAND = 'Brightpath';
  const COLOR = '#ff6a3d';
  const FROM = 'Brightpath <no-reply@brightpath.example.test>';
  const U = await users(P);
  const withEmail = U.list.filter((u) => u.email);
  const withPhone = U.list.filter((u) => u.phone);
  const maya = U.get('maya');
  const sam = U.get('samuel');
  const aisha = U.get('Aisha');
  const tomas = U.get('tomas');
  const hana = U.get('hana');
  const priya = U.get('priya');

  console.log('brightpath: email');
  await step('brightpath SMTP', async () => {
    const emails = [];
    for (const u of withEmail) emails.push(otpEmail(BRAND, COLOR, FROM, u.email, u.name.split(' ')[0], code6()));
    for (const u of withEmail.slice(0, 6)) emails.push(magicEmail(BRAND, COLOR, FROM, u.email, u.name.split(' ')[0]));
    for (const u of withEmail.slice(2, 9))
      emails.push({
        from: FROM,
        to: u.email,
        subject: `Welcome to Brightpath, ${u.name.split(' ')[0]}!`,
        text: `Welcome aboard! Finish your profile: ${APP}/onboarding?step=profile\nYour first workout is ready.`,
        html: htmlWrap(BRAND, COLOR, `<h2>Welcome aboard!</h2><p>Your first workout is ready. <a href="${APP}/onboarding?step=profile">Finish your profile</a>.</p><ul><li>20-minute core</li><li>Easy 5k</li><li>Evening stretch</li></ul>`),
      });
    // Duplicates: the same code email four times (designs fold them into "×4").
    const dup = otpEmail(BRAND, COLOR, FROM, maya.email, 'Maya', '482913');
    for (let i = 0; i < 4; i++) emails.push(dup);
    const weekly = { from: FROM, to: sam.email, subject: 'Your week in Brightpath', text: 'You worked out 3 times this week. Keep going!' };
    for (let i = 0; i < 3; i++) emails.push(weekly);
    emails.push({ from: FROM, to: maya.email, subject: 'Reset your password', text: `Someone asked to reset your password.\nReset it here: ${APP}/reset-password?token=${token()}\nThe link expires in 1 hour.` });
    // Unassigned: nobody has these addresses.
    emails.push(otpEmail(BRAND, COLOR, FROM, 'new.signup.4821@brightpath.example.test', 'there', code6()));
    emails.push({ from: FROM, to: 'qa-team@brightpath.example.test', subject: '[Alert] 12 failed sign-ins in 5 minutes', text: 'Rate limit triggered for 10.0.0.17. Review: ' + APP + '/admin/security' });
    await smtpBatch(P, emails);
  });
  await step('brightpath marketing SMTP', async () => {
    const news = (u) => ({
      from: 'Brightpath News <news@brightpath.example.test>',
      to: u.email,
      subject: 'November challenge: 30 days, 30 workouts',
      text: `Join the November challenge! ${APP}/challenge/november\nUnsubscribe: ${APP}/unsubscribe?u=${u.id}`,
      html: htmlWrap(BRAND, '#6b4eff', `<h2>30 days, 30 workouts</h2><p>Join thousands of members.</p><p><a href="${APP}/challenge/november">Join the challenge</a></p>`),
      headers: { 'List-Unsubscribe': `<${APP}/unsubscribe>` },
    });
    await smtpBatch(`${P}.marketing`, withEmail.slice(0, 8).map(news)); // Nora (opted out) is refused
  });
  await step('brightpath SendGrid', async () => {
    for (const u of withEmail.slice(0, 4)) {
      const r = await call('POST', `/mock/${P}/sendgrid/v3/mail/send`, {
        headers: { authorization: 'Bearer SG.sample' },
        json: {
          personalizations: [{ to: [{ email: u.email, name: u.name }] }],
          from: { email: 'billing@brightpath.example.test', name: 'Brightpath Billing' },
          subject: 'Your Brightpath Premium receipt',
          content: [
            { type: 'text/plain', value: `Thanks for your payment of $59.99 for Premium (annual).\nReceipt: ${APP}/billing/receipts/${token(6)}` },
            { type: 'text/html', value: htmlWrap(BRAND, COLOR, `<p>Thanks for your payment.</p><table><tr><td>Premium (annual)</td><td align="right">$59.99</td></tr></table><p><a href="${APP}/billing">View receipt</a></p>`) },
          ],
        },
      });
      count(r.ok ? 'email (SendGrid API)' : 'email refused (SendGrid API)');
    }
  });

  console.log('brightpath: SMS and WhatsApp');
  await step('brightpath SMS', async () => {
    for (const u of withPhone) await sms('SMS (Twilio)', () => twilioSms(P, 'sms-primary', u.phone, `Your Brightpath code is ${code6()}. Don't share it with anyone.`));
    await sms('SMS (Twilio)', () => twilioSms(P, 'sms-primary', sam.phone, `Your Brightpath code is ${code6()}. Don't share it with anyone.`)); // retry after the failed first one
    for (let i = 0; i < 3; i++) await sms('SMS (Twilio)', () => twilioSms(P, 'sms-primary', aisha.phone, 'Your Brightpath code is 730155. Don\'t share it with anyone.')); // duplicates
    for (let i = 0; i < 4; i++) await sms('SMS (Twilio)', () => twilioSms(P, 'sms-primary', U.get('Fiona').phone, `Reminder: your workout starts at 6 pm. Code ${code6()}`)); // flaky
    await sms('SMS (Twilio)', () => twilioSms(P, 'sms-primary', maya.phone, 'Brightpath: your trainer session is on Thu 9:00. Reply YES to confirm.'));
    await sms('SMS (Twilio)', () => twilioSms(P, 'sms-primary', U.get('Maximiliana').phone, 'Brightpath: Hola Maximiliana! Tu código es 551202 — válido 10 min. 💪')); // UCS-2, 2 segments
    await sms('SMS (Vonage)', () => vonageSms(P, 'sms-backup', priya.phone, `Brightpath (backup route): your code is ${code6()}`));
    await sms('SMS (Vonage)', () => vonageSms(P, 'sms-backup', sam.phone, `Brightpath (backup route): your code is ${code6()}`));
    await sms('SMS (Twilio)', () => twilioSms(P, 'sms-primary', '+15550100999', `Your Brightpath code is ${code6()}`)); // unassigned number
  });
  await step('brightpath WhatsApp', async () => {
    for (const u of [maya, priya, tomas, sam]) await sms('WhatsApp (Meta)', () => metaWa(P, 'whatsapp', u.whatsapp, { type: 'text', text: { body: `Hi ${u.name.split(' ')[0]}! Your coach Priya shared a new plan: ${APP}/plans/${token(5)}` } }));
    for (let i = 0; i < 3; i++) await sms('WhatsApp (Meta)', () => metaWa(P, 'whatsapp', tomas.whatsapp, { type: 'text', text: { body: 'Your Brightpath code is 918273' } }));
    await sms('WhatsApp (Meta)', () =>
      metaWa(P, 'whatsapp', maya.whatsapp, {
        type: 'interactive',
        interactive: { type: 'button', body: { text: 'Did you finish today\'s workout?' }, action: { buttons: [{ type: 'reply', reply: { id: 'DONE', title: 'Done' } }, { type: 'reply', reply: { id: 'SKIP', title: 'Skipped' } }] } },
      }),
    );
    // Hana's AI persona answers this one (auto-reply rule → persona → mock:openai → LLM mocks).
    await sms('WhatsApp (Meta)', () => metaWa(P, 'whatsapp', hana.whatsapp, { type: 'text', text: { body: 'Welcome to the Brightpath beta! Your sign-in code is 246810.' } }));
  });
  await step('brightpath inbound replies', async () => {
    await api('POST', `/api/projects/${P}/users/${aisha.id}/reply`, { channel: 'sms', text: 'STOP' });
    await api('POST', `/api/projects/${P}/users/${tomas.id}/reply`, { channel: 'whatsapp', text: 'Thanks! Can I move my session to Friday?' });
    await api('POST', `/api/projects/${P}/users/${priya.id}/reply`, { channel: 'whatsapp', text: 'Plan sent to Maya 👍' });
    count('inbound replies', 3);
  });

  console.log('brightpath: push');
  await step('brightpath push', async () => {
    const devices = await api('GET', `/api/projects/${P}/push/devices`);
    const dev = (userId, platform) => devices.find((d) => d.testUserId === userId && d.platform === platform);
    const fcm = await fcmClient(P, 'fcm');
    const apns = await apnsClient(P, 'apns');
    const n = (title, body, data) => ({ notification: { title, body }, ...(data ? { data } : {}) });
    await fcm({ token: dev(maya.id, 'android').token, ...n('Workout reminder', 'Your 20-minute core session starts in 10 minutes', { deeplink: 'brightpath://workouts/w1' }) });
    await fcm({ token: dev(priya.id, 'android').token, ...n('New client', 'Maya Chen booked a session for Thursday') });
    await fcm({ token: dev(hana.id, 'web').token, ...n('Beta build 2.4.0', 'New: offline workouts. Tap to read the release notes.', { url: `${APP}/beta/notes` }) });
    for (let i = 0; i < 3; i++) await fcm({ token: dev(maya.id, 'android').token, ...n('Streak at risk', 'Work out today to keep your 12-day streak!') }); // duplicates
    await fcm({ topic: 'news', ...n('Brightpath News', 'November challenge starts Monday') }); // fans out to subscribers
    await fcm({ token: dev(tomas.id, 'android').token, ...n('We miss you', 'Come back for a quick workout') }); // unregistered → 404
    await fcm({ token: dev(maya.id, 'android').token, data: { sync: 'plans', version: '42' } }); // silent data push
    await apns(dev(sam.id, 'ios').token, { alert: { title: 'Session confirmed', body: 'Thursday 9:00 with Priya' }, badge: 1, sound: 'default' });
    await apns(dev(maya.id, 'ios').token, { alert: { title: 'Weekly summary', body: '3 workouts, 2 h 10 min. Nice!' }, badge: 3 }, { deeplink: 'brightpath://summary' });
    await apns(dev(sam.id, 'ios').token, { alert: { title: 'Payment failed', body: 'Update your card to keep Premium' }, badge: 2 });
    // Tap one notification so it shows as read/opened.
    const list = await api('GET', `/api/projects/${P}/push/notifications?user=${maya.id}&limit=1`);
    if (list[0]) await api('POST', `/api/projects/${P}/push/notifications/${list[0].id}/open`);
  });

  console.log('brightpath: webhooks, API mocks, login, AI');
  await step('brightpath webhooks', async () => {
    for (const [t, as] of [['subscription.renewed', maya.email], ['workout.completed', sam.email], ['workout.completed', priya.email], ['workout.completed', maya.email], ['broken.event', null]]) {
      await api('POST', `/api/projects/${P}/webhook-templates/${t}/send`, as ? { asUser: as } : {});
      count('webhook sent');
    }
    await api('POST', `/api/projects/${P}/webhook-sequences/${encodeURIComponent('Renewal with duplicate')}/run`, { asUser: sam.email });
    count('webhook sequence run');
    // Hits from "the app" to the inbound endpoint, one invalid.
    await call('POST', `/hook/${P}/events`, { json: { event: 'app.opened', userId: maya.id, ts: new Date().toISOString() } });
    await call('POST', `/hook/${P}/events`, { json: { event: 'app.opened' } });
    await call('POST', `/hook/${P}/nope`, { json: {} }); // unknown endpoint → 404 in the traffic log
    count('webhook endpoint hits', 3);
  });
  await step('brightpath API mocks', async () => {
    for (const u of [maya, sam, priya]) await call('GET', `/mock/${P}/api/v1/recommendations/${u.id}`);
    await call('GET', `/mock/${P}/api/geo`);
    await call('GET', `/mock/${P}/api/geo`, { headers: { 'X-Hub-Scenario': '503' } });
    await call('GET', `/mock/${P}/api/unknown/path`);
    count('API mock calls', 6);
  });
  await step('brightpath login (Google, Apple)', async () => {
    await oauthLogin(P, 'google', '/o/oauth2/v2/auth', '/token', maya.email);
    await oauthLogin(P, 'google', '/o/oauth2/v2/auth', '/token', sam.email);
    await oauthLogin(P, 'apple', '/auth/authorize', '/auth/token', hana.email, 'openid'); // name/email scopes need form_post
  });
  await step('brightpath AI chat', async () => {
    await api('POST', `/api/projects/${P}/chat/agents/support-bot/ask`, { prompt: 'Which test users are there?' });
    await api('POST', `/api/projects/${P}/chat/agents/coach/ask`, { prompt: 'Can you give me a workout plan for this week?' });
    count('AI chat conversations', 2);
    // Direct calls from "the app" to the fake OpenAI and Anthropic APIs.
    await call('POST', `/llm/${P}/openai/v1/chat/completions`, { headers: { authorization: 'Bearer sk-sample' }, json: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'Suggest a plan for a beginner' }] } });
    await call('POST', `/llm/${P}/anthropic/v1/messages`, { headers: { 'x-api-key': 'sk-ant-sample', 'anthropic-version': '2023-06-01' }, json: { model: 'claude-sonnet-mock', max_tokens: 200, messages: [{ role: 'user', content: 'hello' }] } });
    await api('POST', `/api/projects/${P}/llm/faults`, { fault: 'rate_limit:5', times: 1 });
    await call('POST', `/llm/${P}/openai/v1/chat/completions`, { headers: { authorization: 'Bearer sk-sample' }, json: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'this one hits the rate limit' }] } });
    count('LLM API calls', 3);
  });
  await step('brightpath TOTP', async () => {
    const c = await api('GET', `/api/projects/${P}/authenticators/code?label=${encodeURIComponent('Olivia admin 2FA')}`);
    if (!/^\d{6}$/.test(c.code)) throw new Error('no TOTP code');
    count('TOTP codes read');
  });
}

/** Authorization-code flow against a fake login provider, with login_hint so no picker is shown. */
async function oauthLogin(p, provider, authPath, tokenPath, who, scope = 'openid email profile') {
  const B = `/auth/${p}/${provider}`;
  const redirect = `${APP}/auth/${provider}/callback`;
  const q = new URLSearchParams({ client_id: 'sample-client', redirect_uri: redirect, response_type: 'code', scope, state: token(8), nonce: token(8), login_hint: who });
  const a = await call('GET', `${B}${authPath}?${q}`, { redirect: 'manual' });
  const loc = a.headers.get('location') ?? '';
  const codeParam = new URL(loc, API).searchParams.get('code');
  if (!codeParam) throw new Error(`${provider} authorize → ${a.status} (no code in ${loc.slice(0, 120)})`);
  const t = await call('POST', `${B}${tokenPath}`, { form: { grant_type: 'authorization_code', code: codeParam, redirect_uri: redirect, client_id: 'sample-client', client_secret: 'sample-secret' } });
  if (!t.ok) throw new Error(`${provider} token → ${t.status}`);
  count(`login (${provider})`);
}

// ================================================================ Ledgerline (B2B SaaS)
async function ledgerline() {
  const P = 'ledgerline';
  const BRAND = 'Ledgerline';
  const COLOR = '#0f766e';
  const FROM = 'Ledgerline <hello@ledgerline.example.test>';
  const U = await users(P);
  const withEmail = U.list.filter((u) => u.email);
  console.log('ledgerline: email, SMS, files, webhooks');
  await step('ledgerline SMTP', async () => {
    const emails = [];
    for (const u of withEmail.slice(1)) {
      const link = `${APP}/invite/accept?token=${token()}`;
      emails.push({
        from: FROM,
        to: u.email,
        subject: 'Rebecca Thornton invited you to Acme Holdings on Ledgerline',
        text: `Rebecca invited you to join the Acme Holdings workspace as ${u.role}.\nAccept: ${link}\nThe invite expires in 7 days.`,
        html: htmlWrap(BRAND, COLOR, `<p><b>Rebecca Thornton</b> invited you to join <b>Acme Holdings</b> as <i>${u.role}</i>.</p><p><a href="${link}">Accept invitation</a></p>`),
      });
    }
    for (const u of withEmail.slice(0, 4)) emails.push(otpEmail(BRAND, COLOR, FROM, u.email, u.name.split(' ')[0], code6()));
    const digest = { from: FROM, to: withEmail[0].email, subject: 'Daily digest: 3 invoices overdue', text: 'INV-1042 (Northwind) 12 days late\nINV-1047 (Globex) 5 days late\nINV-1050 (Initech) 1 day late' };
    for (let i = 0; i < 3; i++) emails.push(digest);
    await smtpBatch(P, emails);
  });
  await step('ledgerline Mailgun', async () => {
    for (const [i, u] of withEmail.entries()) {
      const r = await call('POST', `/mock/${P}/mailgun/v3/mg.ledgerline.example.test/messages`, {
        headers: { authorization: `Basic ${Buffer.from('api:key-sample').toString('base64')}` },
        form: { from: 'Ledgerline Invoices <invoices@mg.ledgerline.example.test>', to: u.email, subject: `Invoice INV-${1040 + i} from Acme Holdings`, text: `Amount due: $${(1200 + i * 315).toLocaleString('en-US')}.00\nDue date: 2026-12-15\nPay online: ${APP}/pay/INV-${1040 + i}`, 'o:tag': 'invoice' },
      });
      count(r.ok ? 'email (Mailgun API)' : 'email refused (Mailgun API)');
    }
  });
  await step('ledgerline SES', async () => {
    for (const u of withEmail.slice(0, 6)) {
      const r = await call('POST', `/mock/${P}/ses/v2/email/outbound-emails`, {
        headers: { authorization: 'AWS4-HMAC-SHA256 Credential=AKIASAMPLE/20261123/eu-west-1/ses/aws4_request, SignedHeaders=host, Signature=00' },
        json: { FromEmailAddress: 'eu-billing@ledgerline.example.test', Destination: { ToAddresses: [u.email] }, Content: { Simple: { Subject: { Data: 'Your EU VAT report is ready' }, Body: { Text: { Data: `Download: ${APP}/reports/vat/2026-10` } } } } },
      });
      count(r.ok ? 'email (SES API)' : 'email refused (SES API)');
    }
  });
  await step('ledgerline SMS', async () => {
    for (const u of U.list.filter((x) => x.phone)) {
      await sms('SMS (generic)', () => call('POST', `/mock/${P}/sms/api/send`, { json: { to: u.phone, from: 'LEDGERLINE', message: `Ledgerline login code: ${code6()}` } }));
    }
  });
  await step('ledgerline storage', async () => {
    const files = [
      ['ledgerline-invoices', 'acme/2026/INV-1040.pdf', 'application/pdf', '%PDF-1.4 sample invoice'],
      ['ledgerline-invoices', 'acme/2026/INV-1041.pdf', 'application/pdf', '%PDF-1.4 sample invoice'],
      ['ledgerline-invoices', 'northwind/2026/INV-1042.pdf', 'application/pdf', '%PDF-1.4 sample invoice'],
      ['ledgerline-logos', 'acme.png', 'image/png', 'not really a png'],
      ['ledgerline-logos', 'globex.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ];
    for (const [bucket, key, type, body] of files) {
      const r = await call('PUT', `/storage/${P}/s3/__hub/objects/${bucket}/${key}`, { raw: body, headers: { 'content-type': type } });
      if (!r.ok) throw new Error(`upload ${key} → ${r.status}`);
      count('files uploaded');
    }
    await call('GET', `/storage/${P}/s3/ledgerline-logos/acme.png`);
  });
  await step('ledgerline webhooks', async () => {
    for (const t of ['invoice.paid', 'invoice.paid', 'invoice.paid', 'invoice.overdue', 'invalid.payload']) {
      await api('POST', `/api/projects/${P}/webhook-templates/${t}/send`, {});
      count('webhook sent');
    }
    for (let i = 0; i < 4; i++) await call('GET', `/mock/${P}/api/fx/latest`);
    await call('POST', `/mock/${P}/api/vat/validate`, { json: { vat: 'DE123456789' } });
    count('API mock calls', 5);
  });
  await step('ledgerline login', async () => {
    await oauthLogin(P, 'microsoft', '/common/oauth2/v2.0/authorize', '/common/oauth2/v2.0/token', U.get('mei').email);
    // GitHub: the first login is denied by a rule; the second works.
    for (const who of [U.get('daniel').email, U.get('daniel').email]) {
      await oauthLogin(P, 'github', '/login/oauth/authorize', '/login/oauth/access_token', who).catch(() => count('login denied by a rule (github)'));
    }
  });
}

// ================================================================ Souk (shop, payments)
async function souk() {
  const P = 'souk';
  const BRAND = 'Souk Market';
  const COLOR = '#b45309';
  const FROM = 'Souk Market <orders@souk.example.test>';
  const U = await users(P);
  const customers = U.list.filter((u) => u.role === 'customer');
  console.log('souk: payments');

  const payments = async () => api('GET', `/api/projects/${P}/payments?limit=200`);
  const stripeSession = async (u, amount, item) => {
    const r = await call('POST', `/pay/${P}/stripe/v1/checkout/sessions`, {
      headers: { authorization: 'Bearer sk_test_sample' },
      form: {
        mode: 'payment',
        success_url: `${APP}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP}/checkout/cancel`,
        customer_email: u.email,
        client_reference_id: `order_${token(5)}`,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(amount),
        'line_items[0][price_data][product_data][name]': item,
      },
    });
    if (!r.ok) throw new Error(`Stripe session → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    count('payments created (Stripe)');
    const list = await payments();
    return list.find((x) => JSON.stringify(x).includes(r.data.id)) ?? list[0];
  };
  const complete = async (pay, outcome, user) => {
    const r = await call('POST', `/api/projects/${P}/payments/${pay.id}/complete`, { json: { outcome, user } });
    count(r.ok ? `payment outcome: ${outcome.split(/[:,]/)[0]}` : 'payment outcome refused');
    return r;
  };
  await step('souk Stripe', async () => {
    const [fatima, oliver, chloe, ravi] = customers;
    const carl = U.get('carl');
    await complete(await stripeSession(fatima, 4999, 'Handwoven Berber rug (small)'), 'success', fatima.email);
    const refunded = await stripeSession(oliver, 12900, 'Moroccan tea set, 6 glasses');
    await complete(refunded, 'success', oliver.email);
    await api('POST', `/api/projects/${P}/payments/${refunded.id}/refund`, { reason: 'requested_by_customer' });
    count('refunds');
    const partial = await stripeSession(fatima, 8900, 'Argan oil gift box');
    await complete(partial, 'success', fatima.email);
    await api('POST', `/api/projects/${P}/payments/${partial.id}/refund`, { amount: 2500, reason: 'damaged item' });
    count('refunds');
    await complete(await stripeSession(carl, 2599, 'Spice sampler'), 'success', carl.email); // declined by Carl's rule
    await complete(await stripeSession(chloe, 3450, 'Leather pouf'), 'decline:expired_card', chloe.email);
    await complete(await stripeSession(chloe, 3450, 'Leather pouf'), '3ds_success', chloe.email); // retry works
    await complete(await stripeSession(oliver, 1500, 'Gift card'), 'cancel', oliver.email);
    await stripeSession(ravi, 21000, 'Brass lantern (large)'); // left open: customer never paid
  });
  await step('souk PayPal', async () => {
    const tok = await call('POST', `/pay/${P}/paypal/v1/oauth2/token`, { form: { grant_type: 'client_credentials' }, headers: { authorization: `Basic ${Buffer.from('sample:sample').toString('base64')}` } });
    if (!tok.ok) throw new Error(`PayPal token → ${tok.status}`);
    for (const [u, value] of [[customers[0], '64.00'], [customers[2], '18.50']]) {
      const o = await call('POST', `/pay/${P}/paypal/v2/checkout/orders`, {
        headers: { authorization: `Bearer ${tok.data.access_token}` },
        json: { intent: 'CAPTURE', purchase_units: [{ reference_id: `order_${token(5)}`, amount: { currency_code: 'USD', value } }], application_context: { return_url: `${APP}/paypal/return`, cancel_url: `${APP}/paypal/cancel` } },
      });
      if (!o.ok) throw new Error(`PayPal order → ${o.status} ${JSON.stringify(o.data).slice(0, 200)}`);
      count('payments created (PayPal)');
      const pay = (await payments()).find((x) => JSON.stringify(x).includes(o.data.id));
      if (pay) {
        await complete(pay, 'success', u.email);
        await call('POST', `/pay/${P}/paypal/v2/checkout/orders/${o.data.id}/capture`, { headers: { authorization: `Bearer ${tok.data.access_token}` }, json: {} });
      }
    }
  });
  await step('souk PayTabs', async () => {
    const keys = (await api('GET', `/api/projects/${P}/payment-instances/paytabs?secrets=1`)).config; // generated at import
    const r = await call('POST', `/pay/${P}/paytabs/payment/request`, {
      headers: { authorization: keys.serverKey },
      json: { profile_id: Number(keys.profileId), tran_type: 'sale', tran_class: 'ecom', cart_id: `order_${token(5)}`, cart_currency: 'SAR', cart_amount: 450, cart_description: 'Oud perfume 50 ml', callback: `http://127.0.0.1:4000/hook/${P}/paytabs`, return: `${APP}/paytabs/return`, customer_details: { name: customers[3].name, email: customers[3].email } },
    });
    if (!r.ok) throw new Error(`PayTabs → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    count('payments created (PayTabs)');
    const pay = (await payments()).find((x) => JSON.stringify(x).includes(r.data.tran_ref));
    if (pay) await complete(pay, 'success', customers[3].email); // its callback endpoint answers 500: failed webhook
  });

  console.log('souk: email, SMS, WhatsApp');
  await step('souk email', async () => {
    const emails = [];
    for (const [i, u] of customers.filter((c) => c.email).entries()) {
      emails.push({
        from: FROM,
        to: u.email,
        subject: `Order #SK-${20481 + i} confirmed`,
        text: `Thanks for your order!\nTrack it: ${APP}/orders/SK-${20481 + i}`,
        html: htmlWrap(BRAND, COLOR, `<h2>Thanks for your order!</h2><p>Order <b>#SK-${20481 + i}</b> is confirmed.</p><p><a href="${APP}/orders/SK-${20481 + i}">Track your order</a></p>`),
      });
    }
    const shipped = { from: FROM, to: customers[0].email, subject: 'Your order has shipped', text: `On its way! Tracking: ${APP}/track/1Z999AA10123456784` };
    for (let i = 0; i < 2; i++) emails.push(shipped);
    emails.push({ from: FROM, to: U.get('yusuf').email, subject: 'New order: 3 items, $142.97', text: `Open the merchant dashboard: ${APP}/merchant/orders` });
    await smtpBatch(P, emails);
  });
  await step('souk SMS/WhatsApp', async () => {
    for (const u of customers.filter((c) => c.phone)) {
      await sms('SMS (Twilio)', () => twilioSms(P, 'sms', u.phone, `Souk: your order is out for delivery today. Delivery code ${String(crypto.randomInt(1000, 10000))}.`));
      await sms('WhatsApp (Twilio)', () => twilioSms(P, 'whatsapp', `whatsapp:${u.whatsapp}`, `Hi ${u.name.split(' ')[0]}, your Souk order has shipped 📦 Track: ${APP}/track/${token(5)}`, { From: 'whatsapp:+15550109001' }));
    }
    for (let i = 0; i < 3; i++) await sms('WhatsApp (Twilio)', () => twilioSms(P, 'whatsapp', `whatsapp:${customers[0].whatsapp}`, 'Your Souk verification code is 135790', { From: 'whatsapp:+15550109001' }));
    await api('POST', `/api/projects/${P}/webhook-templates/payment_intent.succeeded/send`, { asUser: customers[0].email });
    count('webhook sent');
    await call('POST', `/mock/${P}/api/shipping/quote`, { json: { postcode: '10001' } });
    count('API mock calls');
  });
}

// ================================================================ Sandbox (almost empty on purpose)
async function sandbox() {
  console.log('sandbox: one email');
  await step('sandbox email', () => smtpBatch('sandbox', [{ from: 'Sandbox <dev@sandbox.example.test>', to: 'test.person@sandbox.example.test', subject: 'Hello from the sandbox', text: 'Just checking the pipes.' }]));
}

// ---------------------------------------------------------------- main
async function main() {
  const sys = await call('GET', '/api/system').catch((e) => ({ ok: false, data: e.message }));
  if (!sys.ok) {
    console.error(`stubyard is not answering at ${API} (${sys.status ?? sys.data}). Start it first (see samples/README.md).`);
    process.exit(1);
  }
  const projects = (await api('GET', '/api/projects')).map((p) => p.slug);
  const missing = PROJECTS.filter((p) => !projects.includes(p));
  if (missing.length) {
    console.error(`Missing projects: ${missing.join(', ')}. Start stubyard with the seed (STUBYARD_DEV_SEED=1 ./scripts/dev.sh) or import samples/seed/*.json.`);
    process.exit(1);
  }
  const existing = await api('GET', '/api/projects/brightpath/messages?limit=1');
  if (existing.length && !AGAIN) {
    console.log('brightpath already has messages: nothing to do. Pass --again to add another round, or reset (see samples/README.md).');
    return;
  }
  console.log(`populating ${API} (SMTP ${SMTP_HOST}:${SMTP_PORT})`);
  await brightpath();
  await ledgerline();
  await souk();
  await sandbox();
  // Let delayed deliveries, callbacks, persona replies and webhooks finish before marking messages read.
  await sleep(6000);
  await step('read status', async () => {
    await markSomeRead('brightpath', 0.45);
    await markSomeRead('ledgerline', 0.3);
    await markSomeRead('souk', 0.6);
  });
  console.log('\nDone:');
  for (const [k, v] of Object.entries(stats).sort()) console.log(`  ${String(v).padStart(4)}  ${k}`);
  if (problems.length) {
    console.log(`\n${problems.length} step(s) had problems:`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
