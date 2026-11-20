import type { Gateway } from './gateway.js';
import { paypalGateway } from './paypal/index.js';
import { paytabsGateway } from './paytabs/index.js';
import { stripeGateway } from './stripe/index.js';

/** The fake payment gateways (Payments 1a). */
export const GATEWAYS: Gateway[] = [stripeGateway, paytabsGateway, paypalGateway];
