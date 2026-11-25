import type { Hub } from '../hub.js';
import type { Project } from '../repos/projects.js';
import type { ProviderInstance } from '../repos/providers.js';
import { telnyxPublicKey } from '../providers/adapters/telnyx.js';
import { getPreset } from '../providers/catalog.js';
import { emailApiSnippets } from './email-api-guide.js';
import { hostHttpBase, hostHttpsBase } from '../config.js';

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

/** Hosts an app uses to reach stubyard, depending on where the app runs. */
export function hostVariants(hub: Hub) {
  return [
    { id: 'host', label: 'App runs on this machine', host: 'localhost' },
    { id: 'docker', label: 'App runs in Docker (shared network)', host: 'stubyard' },
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
        `Point your app's SMTP settings at stubyard. The username selects the project${inst.isDefault ? '' : ' and this provider instance'}; ` +
        'any password works. Use host "stubyard" from containers on the same Docker network, or "host.docker.internal" from other containers.',
      snippets: [
        {
          title: '.env (generic)',
          language: 'dotenv',
          code: `SMTP_HOST=localhost\nSMTP_PORT=${port}\nSMTP_USER=${user}\nSMTP_PASSWORD=stubyard\nSMTP_SECURE=false`,
        },
        {
          title: 'Laravel (.env)',
          language: 'dotenv',
          code: `MAIL_MAILER=smtp\nMAIL_HOST=localhost\nMAIL_PORT=${port}\nMAIL_USERNAME=${user}\nMAIL_PASSWORD=stubyard\nMAIL_ENCRYPTION=null`,
        },
        {
          title: 'Node.js (nodemailer)',
          language: 'javascript',
          code: `const transport = nodemailer.createTransport({\n  host: 'localhost',\n  port: ${port},\n  secure: false,\n  auth: { user: '${user}', pass: 'stubyard' },\n});`,
        },
        {
          title: 'Django (settings.py)',
          language: 'python',
          code: `EMAIL_HOST = "localhost"\nEMAIL_PORT = ${port}\nEMAIL_HOST_USER = "${user}"\nEMAIL_HOST_PASSWORD = "stubyard"\nEMAIL_USE_TLS = False`,
        },
        {
          title: 'Spring Boot (application.properties)',
          language: 'properties',
          code: `spring.mail.host=localhost\nspring.mail.port=${port}\nspring.mail.username=${user}\nspring.mail.password=stubyard\nspring.mail.properties.mail.smtp.auth=true`,
        },
      ],
    });
  }

  for (const inst of instances.filter((i) => !(i.channel === 'email' && i.preset === 'smtp'))) {
    const preset = getPreset(inst.preset);
    const base = `${hostHttpsBase(hub.config)}/mock/${project.slug}/${inst.slug}`;
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
        ? `Point the SDK at stubyard instead of the real API (${hostHttpBase(hub.config)}/mock/${project.slug}/${inst.slug} works too). ` +
          `Messages land in the test user's inbox and follow their scenario rules. ${cb}`
        : `The ${preset?.name ?? inst.preset} simulator is coming in a later phase. Its base URL will be:`,
      snippets: snippets ?? [{ title: 'Base URL', language: 'text', code: base }],
    });
  }

  // Webhooks (Phase 3): URLs for the configured inbound endpoints.
  const hooks = hub.webhooks?.listEndpoints(project.id) ?? [];
  if (hooks.length) {
    const url = (proto: 'http' | 'https', path: string) =>
      `${proto === 'http' ? hostHttpBase(hub.config) : hostHttpsBase(hub.config)}/hook/${project.slug}${path ? `/${path}` : ''}`;
    sections.push({
      id: 'webhooks',
      title: 'Webhook endpoints (stubyard receives)',
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
  const crt = 'stubyard-ca.crt';
  return {
    downloadUrl: '/api/ca.crt',
    fingerprint: hub.tls?.caFingerprint ?? null,
    names: hub.tls?.names ?? [],
    // STUBYARD_PUBLIC_URL: where the browser reaches stubyard (the dashboard's CA trust check). Signed-in only.
    publicUrl: hub.config.publicUrl,
    steps: [
      { title: 'Linux (Debian/Ubuntu)', language: 'bash', code: `sudo cp ${crt} /usr/local/share/ca-certificates/stubyard-ca.crt\nsudo update-ca-certificates` },
      { title: 'Linux (Fedora/RHEL)', language: 'bash', code: `sudo cp ${crt} /etc/pki/ca-trust/source/anchors/\nsudo update-ca-trust` },
      { title: 'macOS', language: 'bash', code: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${crt}` },
      { title: 'Windows (PowerShell as Administrator)', language: 'powershell', code: `Import-Certificate -FilePath .\\${crt} -CertStoreLocation Cert:\\LocalMachine\\Root` },
      { title: 'Node.js', language: 'bash', code: `export NODE_EXTRA_CA_CERTS=/path/to/${crt}` },
      { title: 'PHP (php.ini)', language: 'ini', code: `curl.cainfo = "/path/to/${crt}"\nopenssl.cafile = "/path/to/${crt}"` },
      { title: 'Python (requests / httpx)', language: 'bash', code: `export REQUESTS_CA_BUNDLE=/path/to/${crt}\nexport SSL_CERT_FILE=/path/to/${crt}` },
      { title: 'Java', language: 'bash', code: `keytool -importcert -alias stubyard -file ${crt} -cacerts -storepass changeit -noprompt` },
      {
        title: 'App running in Docker',
        language: 'yaml',
        code: `services:\n  app:\n    volumes:\n      - ./${crt}:/usr/local/share/ca-certificates/stubyard-ca.crt:ro\n    environment:\n      NODE_EXTRA_CA_CERTS: /usr/local/share/ca-certificates/stubyard-ca.crt`,
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
            `// Send every Twilio API call to stubyard instead of api.twilio.com (Messaging) and verify.twilio.com (Verify)\n` +
            `class StubyardClient extends twilio.RequestClient {\n` +
            `  request(opts) {\n    opts.uri = opts.uri.replace('https://api.twilio.com', '${base}').replace('https://verify.twilio.com', '${base}');\n    return super.request(opts);\n  }\n}\n` +
            `const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, { httpClient: new StubyardClient() });\n` +
            `await client.messages.create({ to: '${to}', from: '+15550001111', body: 'Your code is 123456' });\n` +
            `// Twilio Verify: stubyard generates the code and delivers it to the test user (unknown VA… sids are created on first use)\n` +
            `await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verifications.create({ to: '+923001234567', channel: 'sms' });\n` +
            `await client.verify.v2.services(process.env.TWILIO_VERIFY_SID).verificationChecks.create({ to: '+923001234567', code });`,
        },
        {
          title: 'Python (twilio)',
          language: 'python',
          code:
            `from twilio.http.http_client import TwilioHttpClient\nfrom twilio.rest import Client\n\n` +
            `class StubyardClient(TwilioHttpClient):\n    def request(self, method, url, *args, **kwargs):\n` +
            `        url = url.replace("https://api.twilio.com", "${base}").replace("https://verify.twilio.com", "${base}")\n        return super().request(method, url, *args, **kwargs)\n\n` +
            `client = Client(sid, token, http_client=StubyardClient())`,
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
            `// Verify v2 uses apiHost (api.nexmo.com), SMS uses restHost (rest.nexmo.com): point both at stubyard\n` +
            `const vonage = new Vonage({ applicationId, privateKey }, { apiHost: '${base}', restHost: '${base}' });\n` +
            `const { requestId } = await vonage.verify2.newRequest({ brand: 'HYPER', workflow: [{ channel: 'sms', to: '923001234567' }] });\n` +
            `await vonage.verify2.checkCode(requestId, code); // 'completed'`,
        },
        { title: 'PHP (vonage/client)', language: 'php', code: `$client = new Vonage\\Client($credentials, ['base_rest_url' => '${base}']);` },
        { title: 'curl', language: 'bash', code: `curl -X POST ${base}/sms/json -d api_key=k -d api_secret=s -d from=HYPER -d to=923001234567 -d 'text=Your code is 123456'` },
      ];
    case 'unifonic':
      return [
        { title: 'Base URL (replace https://el.cloud.unifonic.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `UNIFONIC_BASE_URL=${base}\nUNIFONIC_APP_SID=stubyard\nUNIFONIC_SENDER_ID=MyBrand` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/rest/SMS/messages -H 'Accept: application/json' \\\n  --data-urlencode AppSid=stubyard --data-urlencode SenderID=MyBrand --data-urlencode Recipient=966500000001 --data-urlencode 'Body=Your code is 123456'`,
        },
      ];
    case 'taqnyat':
      return [
        { title: 'Base URL (replace https://api.taqnyat.sa)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `TAQNYAT_BASE_URL=${base}\nTAQNYAT_BEARER_TOKEN=stubyard\nTAQNYAT_SENDER=MyBrand` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/v1/messages -H 'Authorization: Bearer stubyard' -H 'Content-Type: application/json' \\\n  -d '{"recipients":["966500000001"],"body":"Your code is 123456","sender":"MyBrand"}'`,
        },
      ];
    case 'msegat':
      return [
        { title: 'Base URL (replace https://www.msegat.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `MSEGAT_API_URL=${base}/gw/sendsms.php\nMSEGAT_USERNAME=stubyard\nMSEGAT_API_KEY=stubyard\nMSEGAT_SENDER=MyBrand` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/gw/sendsms.php -H 'Content-Type: application/json' \\\n  -d '{"userName":"stubyard","apiKey":"stubyard","numbers":"966500000001","userSender":"MyBrand","msg":"Your code is 123456"}'`,
        },
      ];
    case '4jawaly':
      return [
        { title: 'Base URL (replace https://api-sms.4jawaly.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `FORJAWALY_URL=${base}/api/v1/\nFORJAWALY_API_KEY=stubyard\nFORJAWALY_API_SECRET=stubyard\nFORJAWALY_SENDER=MyBrand` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/api/v1/account/area/sms/send -u stubyard:stubyard -H 'Content-Type: application/json' \\\n  -d '{"messages":[{"text":"Your code is 123456","numbers":["966500000001"],"sender":"MyBrand"}]}'`,
        },
      ];
    case 'oursms':
      return [
        { title: 'Base URL (replace https://api.oursms.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `OURSMS_API_URL=${base}/msgs/sms\nOURSMS_API_TOKEN=stubyard\nOURSMS_SENDER_NAME=MyBrand` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/msgs/sms -H 'Authorization: Bearer stubyard' -H 'Content-Type: application/json' \\\n  -d '{"src":"MyBrand","dests":["966500000001"],"body":"Your code is 123456"}'`,
        },
      ];
    case 'infobip':
      return [
        { title: 'Base URL (replace https://<subdomain>.api.infobip.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `INFOBIP_BASE_URL=${base}\nINFOBIP_API_KEY=stubyard` },
        {
          title: 'Node.js (@infobip-api/sdk)',
          language: 'javascript',
          code:
            `const { Infobip, AuthType } = require('@infobip-api/sdk');\n` +
            `const infobip = new Infobip({ baseUrl: process.env.INFOBIP_BASE_URL, apiKey: process.env.INFOBIP_API_KEY, authType: AuthType.ApiKey });\n` +
            `await infobip.channels.sms.send({ messages: [{ destinations: [{ to: '923001234567' }], from: 'MyBrand', text: 'Your code is 123456' }] });`,
        },
        {
          title: 'curl (SMS API v3)',
          language: 'bash',
          code: `curl -X POST ${base}/sms/3/messages -H 'Authorization: App stubyard' -H 'Content-Type: application/json' \\\n  -d '{"messages":[{"sender":"MyBrand","destinations":[{"to":"923001234567"}],"content":{"text":"Your code is 123456"}}]}'`,
        },
      ];
    case 'plivo':
      return [
        { title: 'Base URL (replace https://api.plivo.com)', language: 'text', code: base },
        {
          title: 'Python (plivo)',
          language: 'python',
          code: `import plivo\n\nclient = plivo.RestClient(auth_id, auth_token)\nclient.base_uri = "${base}/v1/Account"  # the SDK has no option for this; set the attribute\nclient.messages.create(src="+15550001111", dst="+923001234567", text="Your code is 123456", url="https://your-app/plivo/status")`,
        },
        {
          title: 'Node.js',
          language: 'javascript',
          code: `// plivo-node hard-codes https://api.plivo.com: call the REST API directly (or wrap the client) in development\nawait fetch('${base}/v1/Account/' + AUTH_ID + '/Message/', {\n  method: 'POST',\n  headers: { Authorization: 'Basic ' + Buffer.from(AUTH_ID + ':' + AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/json' },\n  body: JSON.stringify({ src: '+15550001111', dst: '+923001234567', text: 'Your code is 123456' }),\n});`,
        },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/v1/Account/MAXXXXXXXXXXXXXXXXXX/Message/ -u MAXXXXXXXXXXXXXXXXXX:token -H 'Content-Type: application/json' \\\n  -d '{"src":"+15550001111","dst":"+923001234567","text":"Your code is 123456"}'`,
        },
      ];
    case 'sinch':
      return [
        { title: 'Base URL (replace https://us.sms.api.sinch.com or eu.sms.api.sinch.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `SINCH_SMS_BASE_URL=${base}\nSINCH_SERVICE_PLAN_ID=stubyard\nSINCH_API_TOKEN=stubyard` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/xms/v1/stubyard/batches -H 'Authorization: Bearer stubyard' -H 'Content-Type: application/json' \\\n  -d '{"from":"+15550001111","to":["+923001234567"],"body":"Your code is 123456","delivery_report":"per_recipient"}'`,
        },
      ];
    case 'telnyx':
      return [
        { title: 'Base URL (replace https://api.telnyx.com/v2)', language: 'text', code: `${base}/v2` },
        {
          title: '.env (the telnyx SDK reads these)',
          language: 'dotenv',
          code: `TELNYX_BASE_URL=${base}/v2\nTELNYX_API_KEY=stubyard\n# Verifies stubyard's Ed25519 webhook signatures (this instance's key)\nTELNYX_PUBLIC_KEY=${telnyxPublicKey(inst.id)}`,
        },
        {
          title: 'Node.js (telnyx)',
          language: 'javascript',
          code: `const client = new Telnyx({ apiKey: process.env.TELNYX_API_KEY, baseURL: process.env.TELNYX_BASE_URL });\nawait client.messages.send({ from: '+15550001111', to: '+923001234567', text: 'Your code is 123456' });\n// webhooks: const event = await client.webhooks.unwrap(rawBody, { headers: req.headers }); // uses TELNYX_PUBLIC_KEY`,
        },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/v2/messages -H 'Authorization: Bearer stubyard' -H 'Content-Type: application/json' \\\n  -d '{"from":"+15550001111","to":"+923001234567","text":"Your code is 123456"}'`,
        },
      ];
    case 'sns':
      return [
        { title: 'Endpoint (replace https://sns.<region>.amazonaws.com)', language: 'text', code: base },
        { title: '.env (AWS SDKs read AWS_ENDPOINT_URL_SNS)', language: 'dotenv', code: `AWS_ENDPOINT_URL_SNS=${base}\nAWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID=stubyard\nAWS_SECRET_ACCESS_KEY=stubyard` },
        {
          title: 'Node.js (@aws-sdk/client-sns)',
          language: 'javascript',
          code:
            `const sns = new SNSClient({ region: 'us-east-1', endpoint: '${base}' });\n` +
            `await sns.send(new PublishCommand({ PhoneNumber: '+923001234567', Message: 'Your code is 123456',\n` +
            `  MessageAttributes: { 'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: 'MyBrand' } } }));`,
        },
        { title: 'Python (boto3)', language: 'python', code: `sns = boto3.client("sns", region_name="us-east-1", endpoint_url="${base}")\nsns.publish(PhoneNumber="+923001234567", Message="Your code is 123456")` },
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
        {
          title: 'Create a message template (starts PENDING; approve it in Providers → Templates)',
          language: 'bash',
          code: `curl -X POST ${base}/v21.0/$WABA_ID/message_templates -H 'Content-Type: application/json' \\\n  -d '{"name":"order_update","language":"en_US","category":"UTILITY","components":[{"type":"BODY","text":"Order {{1}} shipped"}]}'`,
        },
      ];
    case '360dialog':
      return [
        { title: 'Base URL (replace https://waba-v2.360dialog.io)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `D360_BASE_URL=${base}\nD360_API_KEY=stubyard` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/messages -H 'D360-API-KEY: stubyard' -H 'Content-Type: application/json' \\\n  -d '{"messaging_product":"whatsapp","to":"966500000001","type":"text","text":{"body":"Your code is 123456"}}'`,
        },
      ];
    case 'infobip-whatsapp':
      return [
        { title: 'Base URL (replace https://<your-subdomain>.api.infobip.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `INFOBIP_BASE_URL=${base}\nINFOBIP_API_KEY=stubyard\nINFOBIP_WHATSAPP_SENDER=441134960000` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/whatsapp/1/message/text -H 'Authorization: App stubyard' -H 'Content-Type: application/json' \\\n  -d '{"from":"441134960000","to":"966500000001","content":{"text":"Your code is 123456"}}'`,
        },
      ];
    case 'gupshup':
      return [
        { title: 'Base URL (replace https://api.gupshup.io)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `GUPSHUP_BASE_URL=${base}\nGUPSHUP_API_KEY=stubyard\nGUPSHUP_APP_NAME=MyApp\nGUPSHUP_SOURCE=917834811114` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/wa/api/v1/msg -H 'apikey: stubyard' \\\n  --data-urlencode channel=whatsapp --data-urlencode source=917834811114 --data-urlencode destination=966500000001 \\\n  --data-urlencode src.name=MyApp --data-urlencode 'message={"type":"text","text":"Your code is 123456"}'`,
        },
      ];
    case 'unifonic-whatsapp':
      return [
        { title: 'Base URL (replace https://apis.unifonic.com)', language: 'text', code: base },
        { title: '.env', language: 'dotenv', code: `UNIFONIC_WA_BASE_URL=${base}\nUNIFONIC_PUBLIC_ID=stubyard\nUNIFONIC_SECRET=stubyard` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -X POST ${base}/v1/messages -H 'PublicId: stubyard' -H 'Secret: stubyard' -H 'Content-Type: application/json' \\\n  -d '{"recipient":{"contact":"+966500000001","channel":"whatsapp"},"content":{"type":"text","text":"Your code is 123456"}}'`,
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
