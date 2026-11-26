// OpenAPI contracts (C1): runtime checks of live traffic. Stub: slice S5b implements the request / response checks,
// recording and installObserver (TrafficLogger.outboundObserver → checkAppResponse).

import type { Hub } from '../hub.js';

/** Hooks the contract checks into the hub's traffic. A no-op until slice S5b. */
export function installObserver(_hub: Hub): void {}
