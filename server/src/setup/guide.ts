import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { ProviderInstance } from '../repos/providers.js';
import { getPreset } from '../providers/catalog.js';
import { emailApiSnippets } from './email-api-guide.js';

export interface Snippet {
  title: string;
  language: string;
  code: string;
}

export interface GuideSection {
  id: string;
  title: string;
  description: string;
  instance?: string;
  snippets: Snippet[];
}

/** Hosts an app uses to reach devhub, depending on where the app runs. */
export function hostVariants(hub: Hub) {
  return [
    { id: 'host', label: 'App runs on this machine', host: 'localhost' },
    { id: 'docker', label: 'App runs in Docker (shared network)', host: 'devhub' },
    { id: 'docker-host', label: 'App runs in Docker (no shared network)', host: 'host.docker.internal' },
  ].map((v) => ({
    ...v,
    http: `http://${v.host}:${hub.config.httpPort}`,
    https: `https://${v.host}:${hub.config.httpsPort}`,
    smtpPort: hub.config.smtpPort,
  }));
}

export function setupGuide(hub: Hub, project: Project, instances: ProviderInstance[]) {
  const sections: GuideSection[] = [];
  const port = hub.config.smtpPort;

  for (const inst of instances.filter((i) => i.channel === 'email' && i.preset === 'smtp')) {
    const user = inst.isDefault ? project.slug : `${project.slug}.${inst.slug}`;
    sections.push({
      id: `email-${inst.slug}`,
      instance: inst.slug,
      title: `Email via SMTP — ${inst.name}${inst.isDefault ? ' (default)' : ''}`,
      description:
        `Point your app's SMTP settings at devhub. The username selects the project${inst.isDefault ? '' : ' and this provider instance'}; ` +
        'any password works. Use host "devhub" from containers on the same Docker network, or "host.docker.internal" from other containers.',
      snippets: [
        {
          title: '.env (generic)',
          language: 'dotenv',
          code: `SMTP_HOST=localhost\nSMTP_PORT=${port}\nSMTP_USER=${user}\nSMTP_PASSWORD=devhub\nSMTP_SECURE=false`,
        },
        {
          title: 'Laravel (.env)',
          language: 'dotenv',
          code: `MAIL_MAILER=smtp\nMAIL_HOST=localhost\nMAIL_PORT=${port}\nMAIL_USERNAME=${user}\nMAIL_PASSWORD=devhub\nMAIL_ENCRYPTION=null`,
        },
        {
          title: 'Node.js (nodemailer)',
          language: 'javascript',
          code: `const transport = nodemailer.createTransport({\n  host: 'localhost',\n  port: ${port},\n  secure: false,\n  auth: { user: '${user}', pass: 'devhub' },\n});`,
        },
        {
          title: 'Django (settings.py)',
          language: 'python',
          code: `EMAIL_HOST = "localhost"\nEMAIL_PORT = ${port}\nEMAIL_HOST_USER = "${user}"\nEMAIL_HOST_PASSWORD = "devhub"\nEMAIL_USE_TLS = False`,
        },
        {
          title: 'Spring Boot (application.properties)',
          language: 'properties',
          code: `spring.mail.host=localhost\nspring.mail.port=${port}\nspring.mail.username=${user}\nspring.mail.password=devhub\nspring.mail.properties.mail.smtp.auth=true`,
        },
      ],
    });
  }

  for (const inst of instances.filter((i) => !(i.channel === 'email' && i.preset === 'smtp'))) {
    const preset = getPreset(inst.preset);
    const base = `https://localhost:${hub.config.httpsPort}/mock/${project.slug}/${inst.slug}`;
    const snippets = presetSnippets(inst, base);
    const cb = inst.config.statusCallbackUrl
      ? `Status callbacks go to ${String(inst.config.statusCallbackUrl)}.`
      : inst.config.eventWebhookUrl
        ? `Email events (delivered, bounce, complaint…) go to ${String(inst.config.eventWebhookUrl)}.`
        : inst.channel === 'email'
          ? 'Set an event webhook URL on the Providers page to receive delivery, bounce and complaint events.'
          : 'Set a status callback URL on the Providers page to receive delivery reports.';
    sections.push({
      id: `${inst.channel}-${inst.slug}`,
      instance: inst.slug,
      title: `${preset?.name ?? inst.preset} — ${inst.name}`,
      description: snippets
        ? `Point the SDK at devhub instead of the real API (http://localhost:${hub.config.httpPort}/mock/${project.slug}/${inst.slug} works too). ` +
          `Messages land in the test user's inbox and follow their scenario rules. ${cb}`
        : `The ${preset?.name ?? inst.preset} simulator is coming in a later phase. Its base URL will be:`,
      snippets: snippets ?? [{ title: 'Base URL', language: 'text', code: base }],
    });
  }

  // Webhooks (Phase 3): URLs for the configured inbound endpoints.
  const hooks = hub.webhooks?.listEndpoints(project.id) ?? [];
  if (hooks.length) {
    const url = (proto: 'http' | 'https', path: string) =>
      `${proto}://localhost:${proto === 'http' ? hub.config.httpPort : hub.config.httpsPort}/hook/${project.slug}${path ? `/${path}` : ''}`;
    sections.push({
      id: 'webhooks',
      title: 'Webhook endpoints (devhub receives)',
      description:
        'Point the sender (your app, a provider dashboard or CLI) at these URLs. Every request is logged and validated against the endpoint\'s JSON Schema; :params match any one path segment.',
      snippets: [
        { title: 'HTTP', language: 'text', code: hooks.map((e) => `${e.method.padEnd(6)} ${url('http', e.path)}`).join('\n') },
        { title: 'HTTPS', language: 'text', code: hooks.map((e) => `${e.method.padEnd(6)} ${url('https', e.path)}`).join('\n') },
      ],
    });
  }

  // Login providers (fake OAuth / OIDC): issuer and endpoints, framework snippets, CA trust.
  if (hub.auth) sections.push(...hub.auth.guideSections(project));
  // File storage (S3 family, …): endpoint, credentials, SDK snippets.
  if (hub.storage) sections.push(...hub.storage.guideSections(project));

  return { project: project.slug, hosts: hostVariants(hub), sections, https: httpsGuide(hub) };
}

export function httpsGuide(hub: Hub) {
  const crt = 'devhub-ca.crt';
  return {
    downloadUrl: '/api/ca.crt',
    fingerprint: hub.tls?.caFingerprint ?? null,
    names: hub.tls?.names ?? [],
    steps: [
      { title: 'Linux (Debian/Ubuntu)', language: 'bash', code: `sudo cp ${crt} /usr/local/share/ca-certificates/devhub-ca.crt\nsudo update-ca-certificates` },
      { title: 'Linux (Fedora/RHEL)', language: 'bash', code: `sudo cp ${crt} /etc/pki/ca-trust/source/anchors/\nsudo update-ca-trust` },
      { title: 'macOS', language: 'bash', code: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${crt}` },
      { title: 'Windows (PowerShell as Administrator)', language: 'powershell', code: `Import-Certificate -FilePath .\\${crt} -CertStoreLocation Cert:\\LocalMachine\\Root` },
      { title: 'Node.js', language: 'bash', code: `export NODE_EXTRA_CA_CERTS=/path/to/${crt}` },
      { title: 'PHP (php.ini)', language: 'ini', code: `curl.cainfo = "/path/to/${crt}"\nopenssl.cafile = "/path/to/${crt}"` },
      { title: 'Python (requests / httpx)', language: 'bash', code: `export REQUESTS_CA_BUNDLE=/path/to/${crt}\nexport SSL_CERT_FILE=/path/to/${crt}` },
      { title: 'Java', language: 'bash', code: `keytool -importcert -alias devhub -file ${crt} -cacerts -storepass changeit -noprompt` },
      {
        title: 'App running in Docker',
        language: 'yaml',
        code: `services:\n  app:\n    volumes:\n      - ./${crt}:/usr/local/share/ca-certificates/devhub-ca.crt:ro\n    environment:\n      NODE_EXTRA_CA_CERTS: /usr/local/share/ca-certificates/devhub-ca.crt`,
      },
    ],
  };
}

function presetSnippets(inst: ProviderInstance, base: string): Snippet[] | null {
  const baseSnippet = { title: 'Base URL', language: 'text', code: base };
  switch (inst.preset) {
    case 'twilio':
    case 'twilio-whatsapp': {
      const to = inst.preset === 'twilio-whatsapp' ? 'whatsapp:+923001234567' : '+923001234567';
      return [
        baseSnippet,
        {
          title: 'Node.js (twilio)',
          language: 'javascript',
          code:
            `const twilio = require('twilio');\n` +
            `// Send every Twilio API call to devhub instead of api.twilio.com (Messaging) and verify.twilio.com (Verify)\n` +
            `class DevhubClient extends twilio.RequestClient {\n` +
            `  request(opts) {\n    opts.uri = opts.uri.replace('https://api.twilio.com', '${base}').replace('https://verify.twilio.com', '${base}');\n    return super.request(opts);\n  }\n}\n` +
            `const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { httpClient: new DevhubClient() });\n` +
            `await client.messages.create({ to: '${to}', from: '+15550001111', body: 'Your code is 123456' });\n` +
            `// Twilio Verify: devhub generates the code and delivers it to the test user (unknown VA… sids are created on first use)\n` +
            `await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verifications.create({ to: '+923001234567', channel: 'sms' });\n` +
            `await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verificationChecks.create({ to: '+923001234567', code });`,
        },
        {
          title: 'Python (twilio)',
          language: 'python',
          code:
            `from twilio.http.http_client import TwilioHttpClient\nfrom twilio.rest import Client\n\n` +
            `class DevhubClient(TwilioHttpClient):\n    def request(self, method, url, *args, **kwargs):\n` +
            `        url = url.replace("https://api.twilio.com", "${base}").replace("https://verify.twilio.com", "${base}")\n        return super().request(method, url, *args, **kwargs)\n\n` +
            `client = Client(sid, token, http_client=DevhubClient())`,
        },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/2010-04-01/Accounts/ACxxx/Messages.json \\\n  --data-urlencode 'To=${to}' --data-urlencode 'From=+15550001111' --data-urlencode 'Body=Your code is 123456'`,
        },
      ];
    }
    case 'vonage':
      return [
        baseSnippet,
        {
          title: 'Node.js (@vonage/server-sdk)',
          language: 'javascript',
          code: `const vonage = new Vonage({ apiKey, apiSecret }, { restHost: '${base}' });\nawait vonage.sms.send({ to: '923001234567', from: 'HYPER', text: 'Your code is 123456' });`,
        },
        {
          title: 'Node.js Verify v2 (@vonage/server-sdk)',
          language: 'javascript',
          code:
            `// Verify v2 uses apiHost (api.nexmo.com), SMS uses restHost (rest.nexmo.com): point both at devhub\n` +
            `const vonage = new Vonage({ applicationId, privateKey }, { apiHost: '${base}', restHost: '${base}' });\n` +
            `const { requestId } = await vonage.verify2.newRequest({ brand: 'HYPER', workflow: [{ channel: 'sms', to: '923001234567' }] });\n` +
            `await vonage.verify2.checkCode(requestId, code); // 'completed'`,
        },
        { title: 'PHP (vonage/client)', language: 'php', code: `$client = new Vonage\\Client($credentials, ['base_rest_url' => '${base}']);` },
        { title: 'curl', language: 'bash', code: `curl -X POST ${base}/sms/json -d api_key=k -d api_secret=s -d from=HYPER -d to=923001234567 -d 'text=Your code is 123456'` },
      ];
    case 'meta-whatsapp':
      return [
        { title: 'Graph API base URL (replace https://graph.facebook.com)', language: 'text', code: base },
        {
          title: 'Node.js (fetch)',
          language: 'javascript',
          code:
            `await fetch('${base}/v21.0/' + PHONE_NUMBER_ID + '/messages', {\n  method: 'POST',\n  headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },\n` +
            `  body: JSON.stringify({ messaging_product: 'whatsapp', to: '923001234567', type: 'text', text: { body: 'Your code is 123456' } }),\n});`,
        },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/v21.0/123456/messages -H 'Content-Type: application/json' \\\n  -d '{"messaging_product":"whatsapp","to":"923001234567","type":"text","text":{"body":"Your code is 123456"}}'`,
        },
      ];
    case 'generic-sms':
    case 'generic-whatsapp': {
      const path = inst.config.path ? String(inst.config.path) : '/send';
      return [
        { title: 'Send URL', language: 'text', code: base + (path.startsWith('/') ? path : '/' + path) },
        { title: 'curl', language: 'bash', code: `curl -X POST ${base}${path.startsWith('/') ? path : '/' + path} -H 'Content-Type: application/json' -d '{"to":"+923001234567","message":"Your code is 123456"}'` },
      ];
    }
    default:
      return emailApiSnippets(inst, base);
  }
}
