import crypto from 'node:crypto';
import forge from 'node-forge';

export interface KeyMaterial {
  kid: string;
  alg: 'RS256';
  privatePem: string;
  publicJwk: Record<string, unknown>;
  certPem: string;
}

/** A fresh RS256 signing key with a self-signed X.509 certificate (Google's /oauth2/v1/certs serves PEM certs). */
export function generateSigningKey(commonName: string): KeyMaterial {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  // RFC 7638 thumbprint → 40 hex chars, the shape Google / Microsoft kids have.
  const thumb = crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest('hex').slice(0, 40);
  const publicJwk = { kty: 'RSA', use: 'sig', alg: 'RS256', kid: thumb, n: jwk.n, e: jwk.e };
  return { kid: thumb, alg: 'RS256', privatePem, publicJwk, certPem: selfSignedCert(privatePem, commonName) };
}

function selfSignedCert(privatePem: string, commonName: string): string {
  const key = forge.pki.privateKeyFromPem(privatePem) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = '0' + forge.util.bytesToHex(forge.random.getBytesSync(15));
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: commonName.slice(0, 64) }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(key, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

/** x5c / x5t for the JWKS entry (Microsoft publishes both). */
export function certJwkFields(certPem: string | null): Record<string, unknown> {
  if (!certPem) return {};
  const der = Buffer.from(certPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return { x5c: [der.toString('base64')], x5t: crypto.createHash('sha1').update(der).digest('base64url') };
}
