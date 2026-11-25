export type Channel = 'email' | 'sms' | 'whatsapp';

export interface PresetInfo {
  id: string;
  channel: Channel;
  name: string;
  description: string;
  /** Whether the simulator for this preset is implemented in the current build. */
  available: boolean;
}

/**
 * Provider presets a project can choose from. Each provider instance uses one preset.
 * Simulators for SMS/WhatsApp/email-API presets arrive in phases 2 and 4.
 */
export const PRESETS: PresetInfo[] = [
  { id: 'smtp', channel: 'email', name: 'SMTP', description: 'Any app or framework that sends email over SMTP.', available: true },
  { id: 'sendgrid', channel: 'email', name: 'SendGrid', description: 'SendGrid v3 Mail Send API and event webhooks.', available: true },
  { id: 'mailgun', channel: 'email', name: 'Mailgun', description: 'Mailgun Messages API and event webhooks.', available: true },
  { id: 'ses', channel: 'email', name: 'Amazon SES', description: 'Amazon SES v2 SendEmail API and notifications.', available: true },
  { id: 'resend', channel: 'email', name: 'Resend', description: 'Resend Emails API (single and batch) and Svix-signed webhooks.', available: true },
  { id: 'postmark', channel: 'email', name: 'Postmark', description: 'Postmark Email API (single, batch, templates) and Delivery / Bounce / SpamComplaint webhooks.', available: true },
  { id: 'brevo', channel: 'email', name: 'Brevo (Sendinblue)', description: 'Brevo transactional email API v3 (/v3/smtp/email) and transactional webhooks.', available: true },
  { id: 'mailjet', channel: 'email', name: 'Mailjet', description: 'Mailjet Send API v3.1 and event webhooks.', available: true },
  { id: 'mandrill', channel: 'email', name: 'Mailchimp Transactional (Mandrill)', description: 'Mandrill messages/send and send-template, and signed mandrill_events webhooks.', available: true },
  { id: 'generic-email', channel: 'email', name: 'Generic email API', description: 'Configure any HTTP email API in the dashboard.', available: true },

  { id: 'twilio', channel: 'sms', name: 'Twilio', description: 'Twilio Programmable Messaging (SMS).', available: true },
  { id: 'vonage', channel: 'sms', name: 'Vonage (Nexmo)', description: 'Vonage SMS API (/sms/json).', available: true },
  { id: 'unifonic', channel: 'sms', name: 'Unifonic', description: 'Unifonic SMS REST API (/rest/SMS/messages, AppSid) and DLR webhooks.', available: true },
  { id: 'taqnyat', channel: 'sms', name: 'Taqnyat', description: 'Taqnyat SMS API (/v1/messages, bearer token), balance, sender names and DLR webhooks.', available: true },
  { id: 'msegat', channel: 'sms', name: 'Msegat', description: 'Msegat gateway (/gw/sendsms.php) and Credits.php.', available: true },
  { id: '4jawaly', channel: 'sms', name: '4Jawaly', description: '4Jawaly SMS API (/api/v1/account/area/sms/send, Basic auth), packages balance and DLR webhooks.', available: true },
  { id: 'oursms', channel: 'sms', name: 'OurSMS', description: 'OurSMS API (/msgs/sms, bearer token) and billing credits.', available: true },
  { id: 'infobip', channel: 'sms', name: 'Infobip', description: 'Infobip SMS API (/sms/3/messages and /sms/2/text/advanced, App key), balance and delivery reports.', available: true },
  { id: 'plivo', channel: 'sms', name: 'Plivo', description: 'Plivo Message API (/v1/Account/{auth_id}/Message/, Basic auth) and signed status callbacks.', available: true },
  { id: 'sinch', channel: 'sms', name: 'Sinch', description: 'Sinch SMS REST API batches (/xms/v1/{service_plan_id}/batches, bearer) and delivery reports.', available: true },
  { id: 'telnyx', channel: 'sms', name: 'Telnyx', description: 'Telnyx Messaging API v2 (/v2/messages, bearer) and Ed25519-signed webhooks.', available: true },
  { id: 'sns', channel: 'sms', name: 'Amazon SNS (SMS)', description: 'Amazon SNS Publish to a phone number (AWS query protocol, SigV4). No delivery-report webhook, like SNS.', available: true },
  { id: 'generic-sms', channel: 'sms', name: 'Generic SMS', description: 'Configure any HTTP SMS API in the dashboard.', available: true },

  { id: 'meta-whatsapp', channel: 'whatsapp', name: 'Meta WhatsApp Cloud API', description: 'WhatsApp Cloud API: messages, media and message templates (create, approve / reject, status webhooks).', available: true },
  { id: '360dialog', channel: 'whatsapp', name: '360dialog', description: '360dialog WABA API (Cloud API on waba-v2.360dialog.io, D360-API-KEY header) and its template endpoints.', available: true },
  { id: 'infobip-whatsapp', channel: 'whatsapp', name: 'Infobip WhatsApp', description: 'Infobip WhatsApp API (/whatsapp/1/message/…, App key auth), delivery / seen reports, inbound messages and templates.', available: true },
  { id: 'gupshup', channel: 'whatsapp', name: 'Gupshup WhatsApp', description: 'Gupshup WhatsApp API (form-encoded /wa/api/v1/msg and /template/msg, apikey header), message / template events.', available: true },
  { id: 'unifonic-whatsapp', channel: 'whatsapp', name: 'Unifonic WhatsApp', description: 'Unifonic Conversations API for WhatsApp (/v1/messages, PublicId + Secret headers) and status webhooks.', available: true },
  { id: 'twilio-whatsapp', channel: 'whatsapp', name: 'Twilio WhatsApp', description: 'Twilio Messaging with whatsapp: addresses.', available: true },
  { id: 'generic-whatsapp', channel: 'whatsapp', name: 'Generic WhatsApp', description: 'Configure any HTTP WhatsApp API in the dashboard.', available: true },
];

export const LABELS = ['primary', 'fallback', 'transactional', 'marketing'] as const;

export function getPreset(id: string): PresetInfo | undefined {
  return PRESETS.find((p) => p.id === id);
}
