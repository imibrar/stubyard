import type { ProviderInstance } from '../repos/providers.js';
import type { Snippet } from './guide.js';

/** Setup snippets for email API presets (SendGrid, Mailgun, Amazon SES, generic): point the SDK at stubyard. */
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
