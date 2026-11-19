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
  { id: 'generic-email', channel: 'email', name: 'Generic email API', description: 'Configure any HTTP email API in the dashboard.', available: true },

  { id: 'twilio', channel: 'sms', name: 'Twilio', description: 'Twilio Programmable Messaging (SMS).', available: true },
  { id: 'vonage', channel: 'sms', name: 'Vonage (Nexmo)', description: 'Vonage SMS API (/sms/json).', available: true },
  { id: 'generic-sms', channel: 'sms', name: 'Generic SMS', description: 'Configure any HTTP SMS API in the dashboard.', available: true },

  { id: 'meta-whatsapp', channel: 'whatsapp', name: 'Meta WhatsApp Cloud API', description: 'WhatsApp Cloud API (also used by most resellers, e.g. 360dialog).', available: true },
  { id: 'twilio-whatsapp', channel: 'whatsapp', name: 'Twilio WhatsApp', description: 'Twilio Messaging with whatsapp: addresses.', available: true },
  { id: 'generic-whatsapp', channel: 'whatsapp', name: 'Generic WhatsApp', description: 'Configure any HTTP WhatsApp API in the dashboard.', available: true },
];

export const LABELS = ['primary', 'fallback', 'transactional', 'marketing'] as const;

export function getPreset(id: string): PresetInfo | undefined {
  return PRESETS.find((p) => p.id === id);
}
