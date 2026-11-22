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
import { experienceRoute, framedEntryLint, isExperiencePath } from './kit/router.js';
import { viewFromQuery } from './kit/view.js';
import { walletRoute } from './sdk/wallet.js';

/**
 * Every gateway also serves the checkout kit's browser steps (…/page/<id>/x/…) and reads the page view overrides
 * (?ui=, ?stubyard_lang=, ?stubyard_drawer=) when its hosted page opens. The gateway object itself is unchanged:
 * the wrapper inherits from it and only adds these two hooks.
 */
function withCheckoutKit(g: Gateway): Gateway {
  const w = Object.create(g) as Gateway;
  w.route = async (c) => {
    if (isExperiencePath(c.path)) return experienceRoute(c);
    if (c.path === '/stubyard-sdk/wallet') return walletRoute(c);
    const out = await g.route(c);
    framedEntryLint(c);
    return out;
  };
  w.pageOpen = (svc, p0, query) => {
    const p = g.pageOpen ? g.pageOpen(svc, p0, query) : p0;
    const ov = viewFromQuery(query);
    if (!ov) return p;
    return svc.repo.update(p.id, { providerData: { ...p.providerData, checkoutView: { ...((p.providerData.checkoutView as object | undefined) ?? {}), ...ov } } });
  };
  return w;
}

/** The fake payment gateways (Payments 1a). */
export const GATEWAYS: Gateway[] = [stripeGateway, paytabsGateway, paypalGateway, hyperpayGateway, apsGateway, myfatoorahGateway, geideaGateway, jazzcashGateway, easypaisaGateway, moyasarGateway, tapGateway, tabbyGateway, tamaraGateway, checkoutGateway].map(withCheckoutKit);
