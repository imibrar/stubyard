import { genericEmailAdapter } from './generic.js';
import { mailgunAdapter } from './mailgun.js';
import { sendgridAdapter } from './sendgrid.js';
import { sesAdapter } from './ses.js';
import type { EmailAdapter } from './types.js';

const ADAPTERS: Record<string, EmailAdapter> = {
  sendgrid: sendgridAdapter(),
  mailgun: mailgunAdapter(),
  ses: sesAdapter(),
  'generic-email': genericEmailAdapter(),
};

export function getEmailAdapter(preset: string): EmailAdapter | null {
  return ADAPTERS[preset] ?? null;
}

export type { EmailAdapter } from './types.js';
