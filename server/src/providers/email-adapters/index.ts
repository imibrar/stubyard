import { brevoAdapter } from './brevo.js';
import { genericEmailAdapter } from './generic.js';
import { mailgunAdapter } from './mailgun.js';
import { mailjetAdapter } from './mailjet.js';
import { mandrillAdapter } from './mandrill.js';
import { postmarkAdapter } from './postmark.js';
import { resendAdapter } from './resend.js';
import { sendgridAdapter } from './sendgrid.js';
import { sesAdapter } from './ses.js';
import type { EmailAdapter } from './types.js';

const ADAPTERS: Record<string, EmailAdapter> = {
  sendgrid: sendgridAdapter(),
  mailgun: mailgunAdapter(),
  ses: sesAdapter(),
  resend: resendAdapter(),
  postmark: postmarkAdapter(),
  brevo: brevoAdapter(),
  mailjet: mailjetAdapter(),
  mandrill: mandrillAdapter(),
  'generic-email': genericEmailAdapter(),
};

export function getEmailAdapter(preset: string): EmailAdapter | null {
  return ADAPTERS[preset] ?? null;
}

export type { EmailAdapter } from './types.js';
