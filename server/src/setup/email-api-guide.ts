import type { ProviderInstance } from '../repos/providers.js';
import type { Snippet } from './guide.js';

/** Setup snippets for email API presets (SendGrid, Mailgun, Amazon SES, Resend, Postmark, Brevo, Mailjet, Mandrill, generic): point the SDK at stubyard. */
export function emailApiSnippets(inst: ProviderInstance, base: string): Snippet[] | null {
  const baseSnippet = { title: 'Base URL', language: 'text', code: base };
  switch (inst.preset) {
    case 'sendgrid':
      return [
        { title: 'Base URL (replace https://api.sendgrid.com)', language: 'text', code: base },
        {
          title: 'Node.js (@sendgrid/mail)',
          language: 'javascript',
          code:
            `const sgMail = require('@sendgrid/mail');\nconst client = require('@sendgrid/client');\n` +
            // Order matters: setApiKey() resets baseUrl to api.sendgrid.com, so set the base URL last.
            `sgMail.setClient(client);\nsgMail.setApiKey(process.env.SENDGRID_API_KEY);\n` +
            `// Must come AFTER setApiKey (setApiKey resets the base URL to the real SendGrid)\nclient.setDefaultRequest('baseUrl', '${base}');\n` +
            `await sgMail.send({ to: 'customer1@hyper.test', from: 'no-reply@hyper.app', subject: 'Sign in', text: 'Your code is 123456' });`,
        },
        { title: 'Python (sendgrid)', language: 'python', code: `from sendgrid import SendGridAPIClient\n\nsg = SendGridAPIClient(api_key, host="${base}")` },
        { title: 'PHP (sendgrid/sendgrid)', language: 'php', code: `$sendgrid = new \\SendGrid(getenv('SENDGRID_API_KEY'), ['host' => '${base}']);` },
        {
          title: 'curl',
          language: 'bash',
          code:
            `curl -i -X POST ${base}/v3/mail/send -H 'Authorization: Bearer SG.stubyard' -H 'Content-Type: application/json' \\\n` +
            `  -d '{"personalizations":[{"to":[{"email":"customer1@hyper.test"}]}],"from":{"email":"no-reply@hyper.app"},"subject":"Sign in","content":[{"type":"text/plain","value":"Your code is 123456"}]}'`,
        },
      ];
    case 'mailgun': {
      const domain = inst.config.domain ? String(inst.config.domain) : 'mg.example.com';
      return [
        { title: 'API URL (replace https://api.mailgun.net)', language: 'text', code: base },
        {
          title: 'Node.js (mailgun.js)',
          language: 'javascript',
          code:
            `const Mailgun = require('mailgun.js');\nconst mg = new Mailgun(FormData).client({ username: 'api', key: process.env.MAILGUN_API_KEY, url: '${base}' });\n` +
            `await mg.messages.create('${domain}', { from: 'no-reply@${domain}', to: ['customer1@hyper.test'], subject: 'Sign in', text: 'Your code is 123456' });`,
        },
        {
          title: 'Python (requests)',
          language: 'python',
          code: `requests.post("${base}/v3/${domain}/messages", auth=("api", MAILGUN_API_KEY),\n    data={"from": "no-reply@${domain}", "to": "customer1@hyper.test", "subject": "Sign in", "text": "Your code is 123456"})`,
        },
        { title: 'Laravel (config/services.php)', language: 'php', code: `'mailgun' => [\n    'domain' => '${domain}',\n    'secret' => env('MAILGUN_SECRET'),\n    'endpoint' => '${base.replace(/^https?:\/\//, '')}',\n    'scheme' => 'https',\n],` },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -s --user 'api:key-stubyard' ${base}/v3/${domain}/messages \\\n  -F from='no-reply@${domain}' -F to='customer1@hyper.test' -F subject='Sign in' -F text='Your code is 123456'`,
        },
      ];
    }
    case 'ses':
      return [
        { title: 'Endpoint (replace https://email.<region>.amazonaws.com)', language: 'text', code: base },
        {
          title: 'Node.js (@aws-sdk/client-sesv2)',
          language: 'javascript',
          code:
            `const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');\n` +
            `const ses = new SESv2Client({ region: 'us-east-1', endpoint: '${base}', credentials: { accessKeyId: 'stubyard', secretAccessKey: 'stubyard' } });\n` +
            `await ses.send(new SendEmailCommand({\n  FromEmailAddress: 'no-reply@hyper.app',\n  Destination: { ToAddresses: ['customer1@hyper.test'] },\n` +
            `  Content: { Simple: { Subject: { Data: 'Sign in' }, Body: { Text: { Data: 'Your code is 123456' } } } },\n}));`,
        },
        { title: 'Python (boto3)', language: 'python', code: `ses = boto3.client("sesv2", region_name="us-east-1", endpoint_url="${base}")` },
        {
          title: 'curl',
          language: 'bash',
          code:
            `curl -s -X POST ${base}/v2/email/outbound-emails -H 'Content-Type: application/json' \\\n` +
            `  -d '{"FromEmailAddress":"no-reply@hyper.app","Destination":{"ToAddresses":["customer1@hyper.test"]},"Content":{"Simple":{"Subject":{"Data":"Sign in"},"Body":{"Text":{"Data":"Your code is 123456"}}}}}'`,
        },
      ];
    case 'resend':
      return [
        { title: 'Base URL (replace https://api.resend.com)', language: 'text', code: base },
        { title: '.env (the Resend Node SDK reads RESEND_BASE_URL)', language: 'dotenv', code: `RESEND_BASE_URL=${base}\nRESEND_API_KEY=re_stubyard` },
        {
          title: 'Node.js (resend)',
          language: 'javascript',
          code:
            `const { Resend } = require('resend');\n// baseUrl option, or set RESEND_BASE_URL\nconst resend = new Resend(process.env.RESEND_API_KEY, { baseUrl: '${base}' });\n` +
            `const { data, error } = await resend.emails.send({ from: 'Hyper <no-reply@hyper.app>', to: ['customer1@hyper.test'], subject: 'Sign in', html: '<p>Your code is <b>123456</b></p>' });`,
        },
        {
          title: 'curl',
          language: 'bash',
          code: `curl -s -X POST ${base}/emails -H 'Authorization: Bearer re_stubyard' -H 'Content-Type: application/json' \\\n  -d '{"from":"no-reply@hyper.app","to":["customer1@hyper.test"],"subject":"Sign in","text":"Your code is 123456"}'`,
        },
      ];
    case 'postmark': {
      const https = base.startsWith('https://');
      const host = base.replace(/^https?:\/\//, '');
      return [
        { title: 'Base URL (replace https://api.postmarkapp.com)', language: 'text', code: base },
        {
          title: 'Node.js (postmark)',
          language: 'javascript',
          code:
            `const postmark = require('postmark');\n// requestHost is "host[:port]/path" (no scheme); the SDK prepends http(s)://\n` +
            `const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN, { useHttps: ${https}, requestHost: '${host}' });\n` +
            `await client.sendEmail({ From: 'no-reply@hyper.app', To: 'customer1@hyper.test', Subject: 'Sign in', TextBody: 'Your code is 123456', MessageStream: 'outbound' });`,
        },
        {
          title: 'curl',
          language: 'bash',
          code:
            `curl -s -X POST ${base}/email -H 'X-Postmark-Server-Token: stubyard-server-token' -H 'Content-Type: application/json' -H 'Accept: application/json' \\\n` +
            `  -d '{"From":"no-reply@hyper.app","To":"customer1@hyper.test","Subject":"Sign in","TextBody":"Your code is 123456"}'`,
        },
      ];
    }
    case 'brevo':
      return [
        { title: 'Base URL (replace https://api.brevo.com; the API lives under /v3)', language: 'text', code: `${base}/v3` },
        {
          title: 'Node.js (@getbrevo/brevo)',
          language: 'javascript',
          code:
            `const { BrevoClient } = require('@getbrevo/brevo');\nconst brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY, baseUrl: '${base}/v3' });\n` +
            `// Older SDK (TransactionalEmailsApi): api.basePath = '${base}/v3';\n` +
            `await brevo.transactionalEmails.sendTransacEmail({ sender: { email: 'no-reply@hyper.app', name: 'Hyper' }, to: [{ email: 'customer1@hyper.test' }], subject: 'Sign in', textContent: 'Your code is 123456' });`,
        },
        {
          title: 'curl',
          language: 'bash',
          code:
            `curl -s -X POST ${base}/v3/smtp/email -H 'api-key: xkeysib-stubyard' -H 'Content-Type: application/json' \\\n` +
            `  -d '{"sender":{"email":"no-reply@hyper.app"},"to":[{"email":"customer1@hyper.test"}],"subject":"Sign in","textContent":"Your code is 123456"}'`,
        },
      ];
    case 'mailjet': {
      const host = base.replace(/^https?:\/\//, '');
      return [
        { title: 'Base URL (replace https://api.mailjet.com)', language: 'text', code: base },
        {
          title: 'Node.js (node-mailjet)',
          language: 'javascript',
          code:
            `const Mailjet = require('node-mailjet');\n// node-mailjet only speaks HTTPS: use stubyard's HTTPS port and trust its CA (NODE_EXTRA_CA_CERTS, see HTTPS on this page).\n` +
            `const mailjet = new Mailjet({ apiKey: process.env.MJ_APIKEY_PUBLIC, apiSecret: process.env.MJ_APIKEY_PRIVATE, config: { host: '${host}' } });\n` +
            `await mailjet.post('send', { version: 'v3.1' }).request({ Messages: [{ From: { Email: 'no-reply@hyper.app' }, To: [{ Email: 'customer1@hyper.test' }], Subject: 'Sign in', TextPart: 'Your code is 123456' }] });`,
        },
        {
          title: 'curl',
          language: 'bash',
          code:
            `curl -s -X POST ${base}/v3.1/send --user 'stubyard-key:stubyard-secret' -H 'Content-Type: application/json' \\\n` +
            `  -d '{"Messages":[{"From":{"Email":"no-reply@hyper.app"},"To":[{"Email":"customer1@hyper.test"}],"Subject":"Sign in","TextPart":"Your code is 123456"}]}'`,
        },
      ];
    }
    case 'mandrill':
      return [
        { title: 'API URL (replace https://mandrillapp.com/api/1.3)', language: 'text', code: `${base}/api/1.3` },
        {
          title: 'Node.js (@mailchimp/mailchimp_transactional)',
          language: 'javascript',
          code:
            `const mailchimp = require('@mailchimp/mailchimp_transactional')(process.env.MANDRILL_API_KEY);\n// The SDK has no option for it, but basePath is a plain property\nmailchimp.basePath = '${base}/api/1.3';\n` +
            `const res = await mailchimp.messages.send({ message: { from_email: 'no-reply@hyper.app', to: [{ email: 'customer1@hyper.test', type: 'to' }], subject: 'Sign in', text: 'Your code is 123456' } });`,
        },
        {
          title: 'curl',
          language: 'bash',
          code:
            `curl -s -X POST ${base}/api/1.3/messages/send.json -H 'Content-Type: application/json' \\\n` +
            `  -d '{"key":"md-stubyard","message":{"from_email":"no-reply@hyper.app","to":[{"email":"customer1@hyper.test","type":"to"}],"subject":"Sign in","text":"Your code is 123456"}}'`,
        },
      ];
    case 'generic-email': {
      const path = inst.config.path ? String(inst.config.path) : '/send';
      const url = base + (path.startsWith('/') ? path : '/' + path);
      return [
        { ...baseSnippet, title: 'Send URL', code: url },
        { title: 'curl', language: 'bash', code: `curl -X POST ${url} -H 'Content-Type: application/json' \\\n  -d '{"to":"customer1@hyper.test","from":"no-reply@hyper.app","subject":"Sign in","text":"Your code is 123456"}'` },
      ];
    }
    default:
      return null;
  }
}
