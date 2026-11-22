// Build-time flags (vite.config.ts `define`).
/** True only in the test build (`npm run build:test`, vite mode "harness"): exposes test hooks such as self.__stubyardCommand. */
declare const __STUBYARD_TEST_HOOKS__: boolean;
