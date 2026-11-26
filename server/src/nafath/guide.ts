import type { GuideSection, Snippet } from '../setup/guide.js';
import { NAFATH_HOSTS } from './host.js';
import type { NafathInstance } from './types.js';

/** A place the app runs and the stubyard origin it uses (setup/guide.ts hostVariants). */
export interface NafathHostVariant {
  id: string;
  label: string;
  http: string;
}

/** The app-facing URLs of an instance. */
export function nafathUrls(origin: string, project: { slug: string }, inst: { slug: string }) {
  const base = `${origin}/nafath/${project.slug}/${inst.slug}`;
  return {
    base,
    request: `${base}/api/v1/mfa/request`,
    status: `${base}/api/v1/mfa/request/status`,
    info: `${base}/api/v1/mfa/request/info`,
    jwk: `${base}/api/v1/mfa/jwk`,
    sandboxBase: `${base}/nafath-sandbox`,
    stagingBase: `${base}/stg`,
  };
}

/**
 * Connect data of an instance (GET …/nafath/instances/:instance/connect and the setup guide): URLs, credentials, env,
 * base URLs per host variant, host mode, and snippets (Node fetch + jose, laravel-nafath, nafath-php, curl).
 */
export function nafathConnect(origin: string, project: { slug: string }, inst: NafathInstance, hosts: NafathHostVariant[], caUrl: string) {
  const urls = nafathUrls(origin, project, inst);
  const env = { NAFATH_BASE_URL: urls.base, NAFATH_APP_ID: inst.appId, NAFATH_APP_KEY: inst.appKey, NAFATH_JWK_URL: urls.jwk };
  const dotenv = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const hostsEntry = `127.0.0.1 ${NAFATH_HOSTS.join(' ')}`;
  const snippets: Snippet[] = [
    { title: '.env', language: 'dotenv', code: dotenv },
    {
      title: 'Base URL by where the app runs',
      language: 'text',
      code: hosts.map((h) => `${h.label.padEnd(40)} ${h.http}/nafath/${project.slug}/${inst.slug}`).join('\n'),
    },
    {
      title: 'Node (fetch + jose)',
      language: 'javascript',
      code: `import { createRemoteJWKSet, jwtVerify } from 'jose';

const base = process.env.NAFATH_BASE_URL; // ${urls.base}
const headers = { 'APP-ID': process.env.NAFATH_APP_ID, 'APP-KEY': process.env.NAFATH_APP_KEY, 'content-type': 'application/json', 'X-Forwarded-For': userIp };

// 1. Start: show \`random\` to the user, who picks the same number in the Nafath app
// (in stubyard: POST /api/projects/${project.slug}/nafath/requests/<transId>/choose {number}, or the dashboard).
const { transId, random } = await (await fetch(\`\${base}/api/v1/mfa/request?local=en&requestId=\${crypto.randomUUID()}\`, {
  method: 'POST', headers, body: JSON.stringify({ nationalId, service: 'Login' }),
})).json();

// 2. Poll until it is no longer WAITING (or wait for the callback).
let status = 'WAITING';
while (status === 'WAITING') {
  await new Promise((r) => setTimeout(r, 2000));
  ({ status } = await (await fetch(\`\${base}/api/v1/mfa/request/status\`, { method: 'POST', headers, body: JSON.stringify({ nationalId, transId, random }) })).json());
}

// 3. Verify a callback token against the JWK set (RS256, by kid).
const jwks = createRemoteJWKSet(new URL(process.env.NAFATH_JWK_URL));
const { payload } = await jwtVerify(callbackBody.token, jwks, { audience: process.env.NAFATH_APP_ID });`,
    },
    {
      title: 'Laravel (devmahmoudmustafa/laravel-nafath)',
      language: 'dotenv',
      code: `# Point the package's base URL / endpoint settings (config/nafath.php after vendor:publish) at stubyard:
NAFATH_BASE_URL=${urls.base}
NAFATH_APP_ID=${inst.appId}
NAFATH_APP_KEY=${inst.appKey}
# The endpoint paths stay the real ones: /api/v1/mfa/request, /api/v1/mfa/request/status, /api/v1/mfa/request/info, /api/v1/mfa/jwk.
# Sandbox / staging prefixes work too: ${urls.sandboxBase}, ${urls.stagingBase}`,
    },
    {
      title: 'PHP (hamada-emam-tech/nafath-php)',
      language: 'text',
      code: `Set the client's base URL to ${urls.base}
(instead of https://rabet-nafath.api.elm.sa), with APP-ID ${inst.appId} and APP-KEY ${inst.appKey}.`,
    },
    {
      title: 'curl',
      language: 'bash',
      code: `curl -X POST '${urls.request}?local=en&requestId=1' \\\n  -H 'APP-ID: ${inst.appId}' -H 'APP-KEY: ${inst.appKey}' -H 'content-type: application/json' \\\n  -d '{"nationalId":"<test user national ID>","service":"Login"}'`,
    },
    {
      title: 'Callback',
      language: 'text',
      code: inst.config.callbackUrl
        ? `stubyard POSTs {transId, requestId, status, token} to ${inst.config.callbackUrl} on COMPLETED / REJECTED (in real Nafath, Elm registers this URL for you).`
        : 'No callback URL yet: set config.callbackUrl on the instance and stubyard POSTs {transId, requestId, status, token} there on COMPLETED / REJECTED (in real Nafath, Elm registers this URL for you).',
    },
    {
      title: 'Host mode (keep the real Elm URL)',
      language: 'text',
      code: `# /etc/hosts (or the container's extra_hosts):
${hostsEntry}
# STUBYARD_TLS_NAMES=${NAFATH_HOSTS.join(',')}, trust the stubyard CA (${caUrl}) and run stubyard's HTTPS on 443 (or a proxy).
# The instance is found by the APP-ID header (${inst.appId}); /nafath-sandbox and /stg prefixes are accepted.`,
    },
  ];
  return {
    instance: inst.slug,
    appId: inst.appId,
    appKey: inst.appKey,
    urls,
    env,
    dotenv,
    hosts: hosts.map((h) => ({ id: h.id, label: h.label, baseUrl: `${h.http}/nafath/${project.slug}/${inst.slug}` })),
    hostMode: { hosts: NAFATH_HOSTS, hostsEntry, caUrl },
    callbackUrl: inst.config.callbackUrl,
    snippets,
  };
}

/** setupGuide() sections, one per instance (id nafath-<instance>). */
export function nafathGuideSections(origin: string, project: { slug: string }, instances: NafathInstance[], hosts: NafathHostVariant[], caUrl: string): GuideSection[] {
  return instances.map((inst) => {
    const c = nafathConnect(origin, project, inst, hosts, caUrl);
    return {
      id: `nafath-${inst.slug}`,
      instance: inst.slug,
      title: `Nafath — ${inst.name}`,
      description:
        `Fake Nafath (Saudi national SSO, MFA API). Point the app's Nafath base URL at ${c.urls.base} and send APP-ID ${inst.appId}. ` +
        `${inst.strict ? 'Strict: wrong credentials and unknown national IDs are errors.' : 'Lax: any APP-ID / APP-KEY and unknown national IDs are accepted (with a warning).'} ` +
        `Decide a request with POST /api/projects/${project.slug}/nafath/requests/<transId>/choose {number} (or approve / reject).`,
      snippets: c.snippets,
    };
  });
}
