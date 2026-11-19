import { genericAdapter } from './generic.js';
import { metaWhatsappAdapter } from './meta.js';
import { twilioAdapter } from './twilio.js';
import type { ProviderAdapter } from './types.js';
import { vonageAdapter } from './vonage.js';

const ADAPTERS: Record<string, ProviderAdapter> = {
  twilio: twilioAdapter('twilio'),
  'twilio-whatsapp': twilioAdapter('twilio-whatsapp'),
  vonage: vonageAdapter(),
  'generic-sms': genericAdapter('generic-sms'),
  'meta-whatsapp': metaWhatsappAdapter(),
  'generic-whatsapp': genericAdapter('generic-whatsapp'),
};

export function getAdapter(preset: string): ProviderAdapter | null {
  return ADAPTERS[preset] ?? null;
}

export type { ProviderAdapter } from './types.js';
