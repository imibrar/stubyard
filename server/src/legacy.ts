/**
 * The product was called "devhub" before it was renamed to stubyard. Existing setups still depend on a few of the old
 * names (DEVHUB_* environment variables, the "devhub" Docker network alias and TLS name, the default storage keys,
 * project exports and the login-as cookie), so they keep working next to the new ones.
 */
export const LEGACY_NAME = 'devhub';
