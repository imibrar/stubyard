import type { Gateway } from './gateway.js';
import { hyperpayGateway } from './hyperpay/index.js';
import { paypalGateway } from './paypal/index.js';
import { paytabsGateway } from './paytabs/index.js';
import { stripeGateway } from './stripe/index.js';
import { apsGateway } from './aps/index.js';
import { myfatoorahGateway } from './myfatoorah/index.js';
import { geideaGateway } from './geidea/index.js';
import { jazzcashGateway } from './jazzcash/index.js';
import { easypaisaGateway } from './easypaisa/index.js';
import { moyasarGateway } from './moyasar/index.js';
import { tapGateway } from './tap/index.js';
import { tabbyGateway } from './tabby/index.js';
import { tamaraGateway } from './tamara/index.js';
import { checkoutGateway } from './checkout/index.js';

/** The fake payment gateways (Payments 1a). */
export const GATEWAYS: Gateway[] = [stripeGateway, paytabsGateway, paypalGateway, hyperpayGateway, apsGateway, myfatoorahGateway, geideaGateway, jazzcashGateway, easypaisaGateway, moyasarGateway, tapGateway, tabbyGateway, tamaraGateway, checkoutGateway];
