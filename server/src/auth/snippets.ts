import type { AuthProvider } from '../repos/auth.js';
import type { PresetDef, ProviderUrls } from './presets/types.js';

export interface Snippet {
  title: string;
  language: string;
  code: string;
}

/** "Connect your app" snippets for a login provider (the dashboard shows them; GET …/auth/:provider returns them). */
export function buildSnippets(
  preset: PresetDef,
  p: AuthProvider,
  urls: { browser: ProviderUrls; backend: ProviderUrls; backendLocal: ProviderUrls },
  o: { clientId: string; clientSecret: string; httpsPort: number },
): Snippet[] {
  const b = urls.backend;
  const env = (name: string, v: string | null) => (v ? `${name}=${v}` : null);
  const P = p.slug.toUpperCase().replace(/-/g, '_');
  const out: Snippet[] = [];
  out.push({
    title: '.env',
    language: 'bash',
    code: [
      env(`${P}_CLIENT_ID`, o.clientId),
      env(`${P}_CLIENT_SECRET`, o.clientSecret),
      preset.protocol === 'oidc' ? env(`${P}_ISSUER`, b.issuer) : null,
      env(`${P}_AUTHORIZATION_URL`, urls.browser.authorize),
      env(`${P}_TOKEN_URL`, b.token),
      env(`${P}_USERINFO_URL`, b.userinfo),
      env(`${P}_JWKS_URL`, b.jwks),
    ]
      .filter(Boolean)
      .join('\n'),
  });
  if (preset.protocol === 'oidc') {
    out.push({
      title: 'openid-client (Node)',
      language: 'ts',
      code: `import * as client from 'openid-client';\n\nconst config = await client.discovery(new URL('${b.discovery ?? b.issuer}'), '${o.clientId}', '${o.clientSecret}');\n// authorize → client.buildAuthorizationUrl(config, { redirect_uri, scope: '${preset.defaultScope}', code_challenge, code_challenge_method: 'S256', state, nonce })\n// callback  → await client.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier, expectedState, expectedNonce })`,
    });
    out.push({
      title: 'Auth.js / NextAuth',
      language: 'ts',
      code: `${providerImport(preset)}({\n  clientId: process.env.${P}_CLIENT_ID,\n  clientSecret: process.env.${P}_CLIENT_SECRET,\n  issuer: '${b.issuer}',\n  // stubyard serves HTTPS with its own CA: set NODE_EXTRA_CA_CERTS (see below)\n})`,
    });
    out.push({
      title: 'Spring Security (application.yml)',
      language: 'yaml',
      code: `spring:\n  security:\n    oauth2:\n      client:\n        registration:\n          ${p.slug}:\n            client-id: ${o.clientId}\n            client-secret: ${o.clientSecret}\n            scope: ${preset.defaultScope.split(/[ ,]+/).join(',')}\n            provider: ${p.slug}\n        provider:\n          ${p.slug}:\n            issuer-uri: ${b.issuer}`,
    });
  } else {
    out.push({
      title: 'Auth.js / NextAuth',
      language: 'ts',
      code: `${providerImport(preset)}({\n  clientId: process.env.${P}_CLIENT_ID,\n  clientSecret: process.env.${P}_CLIENT_SECRET,\n  authorization: { url: '${urls.browser.authorize}' },\n  token: '${b.token}',\n  userinfo: '${b.userinfo}',\n})`,
    });
    out.push({
      title: 'Spring Security (application.yml)',
      language: 'yaml',
      code: `spring:\n  security:\n    oauth2:\n      client:\n        provider:\n          ${p.slug}:\n            authorization-uri: ${urls.browser.authorize}\n            token-uri: ${b.token}\n            user-info-uri: ${b.userinfo}\n            user-name-attribute: ${preset.id === 'x' ? 'data' : 'id'}`,
    });
  }
  out.push({
    title: 'Passport',
    language: 'js',
    code: `new ${passportName(preset)}({\n  clientID: process.env.${P}_CLIENT_ID,\n  clientSecret: process.env.${P}_CLIENT_SECRET,\n  callbackURL: 'http://localhost:3000/auth/${preset.id}/callback',\n  authorizationURL: '${urls.browser.authorize}',\n  tokenURL: '${b.token}',\n  ${preset.id === 'facebook' ? 'profileURL' : 'userProfileURL'}: '${b.userinfo ?? ''}',\n}, verify)`,
  });
  if (preset.id === 'google') {
    out.push({
      title: 'google-auth-library',
      language: 'ts',
      code: `const client = new OAuth2Client({\n  clientId, clientSecret, redirectUri,\n  endpoints: {\n    oauth2AuthBaseUrl: '${urls.browser.authorize}',\n    oauth2TokenUrl: '${b.token}',\n    oauth2RevokeUrl: '${b.revoke}',\n    oauth2FederatedSignonPemCertsUrl: '${b.base}/oauth2/v1/certs',\n    oauth2FederatedSignonJwkCertsUrl: '${b.jwks}',\n    tokenInfoUrl: '${b.base}/tokeninfo',\n  },\n  issuers: ['${b.issuer}'],\n});\nconst ticket = await client.verifyIdToken({ idToken, audience: clientId });`,
    });
  }
  if (preset.id === 'microsoft') {
    out.push({
      title: 'MSAL Node (@azure/msal-node)',
      language: 'ts',
      code: `const msal = new ConfidentialClientApplication({\n  auth: {\n    clientId, clientSecret,\n    authority: '${b.issuer}',\n    knownAuthorities: ['${new URL(b.base).host}'],\n  },\n  system: { protocolMode: 'OIDC' },\n});`,
    });
  }
  if (preset.id === 'github') {
    out.push({
      title: 'Laravel Socialite (GitHub Enterprise style)',
      language: 'php',
      code: `// A custom provider extending GithubProvider: override getAuthUrl / getTokenUrl / getUserByToken\nprotected function getAuthUrl($state) { return $this->buildAuthUrlFromBase('${urls.browser.authorize}', $state); }\nprotected function getTokenUrl() { return '${b.token}'; }\n// user: GET ${b.base}/api/v3/user`,
    });
  }
  out.push({
    title: 'Trust the stubyard CA (HTTPS issuers)',
    language: 'bash',
    code: `curl -o stubyard-ca.crt http://localhost:4000/api/ca.crt\nexport NODE_EXTRA_CA_CERTS=$PWD/stubyard-ca.crt           # Node\nexport SSL_CERT_FILE=$PWD/stubyard-ca.crt CURL_CA_BUNDLE=$PWD/stubyard-ca.crt  # PHP/curl, Python, Ruby\nkeytool -importcert -alias stubyard -file stubyard-ca.crt -cacerts -storepass changeit -noprompt  # Java`,
  });
  return out;
}

function providerImport(p: PresetDef): string {
  const names: Record<string, string> = { google: 'Google', microsoft: 'MicrosoftEntraID', github: 'GitHub', facebook: 'Facebook', linkedin: 'LinkedIn', apple: 'Apple', x: 'Twitter', discord: 'Discord', gitlab: 'GitLab', slack: 'Slack', oidc: 'Keycloak /* or any OIDC provider */' };
  return names[p.id] ?? 'OIDC';
}

function passportName(p: PresetDef): string {
  const names: Record<string, string> = { google: 'GoogleStrategy', github: 'GitHubStrategy', facebook: 'FacebookStrategy', linkedin: 'OAuth2Strategy', microsoft: 'OAuth2Strategy', discord: 'DiscordStrategy', gitlab: 'GitLabStrategy', x: 'OAuth2Strategy', slack: 'OAuth2Strategy', apple: 'AppleStrategy', oidc: 'OAuth2Strategy' };
  return names[p.id] ?? 'OAuth2Strategy';
}
