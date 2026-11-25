import { genericAdapter } from './generic.js';
import { gupshupAdapter } from './gupshup.js';
import { infobipWhatsappAdapter } from './infobip-whatsapp.js';
import { unifonicWhatsappAdapter } from './unifonic-whatsapp.js';
import { infobipAdapter } from './infobip.js';
import { jawalyAdapter } from './jawaly.js';
import { metaWhatsappAdapter } from './meta.js';
import { msegatAdapter } from './msegat.js';
import { oursmsAdapter } from './oursms.js';
import { plivoAdapter } from './plivo.js';
import { sinchAdapter } from './sinch.js';
import { snsAdapter } from './sns.js';
import { taqnyatAdapter } from './taqnyat.js';
import { telnyxAdapter } from './telnyx.js';
import { twilioAdapter } from './twilio.js';
import type { ProviderAdapter } from './types.js';
import { unifonicAdapter } from './unifonic.js';
import { vonageAdapter } from './vonage.js';

const ADAPTERS: Record<string, ProviderAdapter> = {
  twilio: twilioAdapter('twilio'),
  'twilio-whatsapp': twilioAdapter('twilio-whatsapp'),
  vonage: vonageAdapter(),
  unifonic: unifonicAdapter(),
  taqnyat: taqnyatAdapter(),
  msegat: msegatAdapter(),
  '4jawaly': jawalyAdapter(),
  oursms: oursmsAdapter(),
  infobip: infobipAdapter(),
  plivo: plivoAdapter(),
  sinch: sinchAdapter(),
  telnyx: telnyxAdapter(),
  sns: snsAdapter(),
  'generic-sms': genericAdapter('generic-sms'),
  'meta-whatsapp': metaWhatsappAdapter(),
  '360dialog': metaWhatsappAdapter('360dialog'),
  'infobip-whatsapp': infobipWhatsappAdapter(),
  gupshup: gupshupAdapter(),
  'unifonic-whatsapp': unifonicWhatsappAdapter(),
  'generic-whatsapp': genericAdapter('generic-whatsapp'),
};

export function getAdapter(preset: string): ProviderAdapter | null {
  return ADAPTERS[preset] ?? null;
}

export type { ProviderAdapter } from './types.js';
