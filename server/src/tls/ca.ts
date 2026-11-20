import forge from 'node-forge';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_NAME } from '../legacy.js';

export interface TlsMaterial {
  caCertPem: string;
  certPem: string;
  keyPem: string;
  names: string[];
  caFingerprint: string;
  caCreatedAt: string;
}

const DEFAULT_NAMES = ['localhost', '127.0.0.1', '::1', 'stubyard', LEGACY_NAME, 'host.docker.internal'];

/**
 * Load (or create on first start) a local CA in <dir>, then make sure a server certificate
 * signed by it covers every requested hostname. The CA key never leaves <dir>.
 */
export function ensureTls(dir: string, extraNames: string[] = []): TlsMaterial {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caKeyFile = path.join(dir, 'ca.key');
  const caCertFile = path.join(dir, 'ca.crt');
  const keyFile = path.join(dir, 'server.key');
  const certFile = path.join(dir, 'server.crt');
  const namesFile = path.join(dir, 'server.names.json');

  // A stored CA that OpenSSL rejects (e.g. one written by an older stubyard whose random serial number could
  // be DER-encoded with an illegal leading zero byte) is useless for TLS: replace it instead of crashing.
  const stored = fs.existsSync(caKeyFile) && fs.existsSync(caCertFile) ? loadCa(caKeyFile, caCertFile) : null;
  let caKey: forge.pki.rsa.PrivateKey;
  let caCert: forge.pki.Certificate;
  if (stored) {
    ({ key: caKey, cert: caCert } = stored);
  } else {
    ({ key: caKey, cert: caCert } = createCa());
    writePrivate(caKeyFile, forge.pki.privateKeyToPem(caKey));
    writeAtomic(caCertFile, forge.pki.certificateToPem(caCert));
    // A new CA invalidates any existing leaf certificate.
    fs.rmSync(certFile, { force: true });
  }

  const names = [...new Set([...DEFAULT_NAMES, ...extraNames].map((n) => n.trim().toLowerCase()).filter(Boolean))].sort();
  const previous = fs.existsSync(namesFile) ? (JSON.parse(fs.readFileSync(namesFile, 'utf8')) as string[]) : [];
  const needLeaf =
    !fs.existsSync(certFile) ||
    !fs.existsSync(keyFile) ||
    JSON.stringify(previous) !== JSON.stringify(names) ||
    !leafUsable(keyFile, certFile, caCertFile);

  if (needLeaf) {
    const { key, cert } = createLeaf(caKey, caCert, names);
    writePrivate(keyFile, forge.pki.privateKeyToPem(key));
    writeAtomic(certFile, forge.pki.certificateToPem(cert));
    writeAtomic(namesFile, JSON.stringify(names));
  }

  const caCertPem = fs.readFileSync(caCertFile, 'utf8');
  return {
    caCertPem,
    certPem: fs.readFileSync(certFile, 'utf8') + caCertPem,
    keyPem: fs.readFileSync(keyFile, 'utf8'),
    names,
    caFingerprint: fingerprint(caCert),
    caCreatedAt: caCert.validity.notBefore.toISOString(),
  };
}

/** Delete the CA and server certificate so they are recreated on the next ensureTls(). */
export function regenerateTls(dir: string, extraNames: string[] = []): TlsMaterial {
  for (const f of ['ca.key', 'ca.crt', 'server.key', 'server.crt', 'server.names.json']) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
  return ensureTls(dir, extraNames);
}

function createCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: `stubyard local CA (${os.hostname()})` },
    { name: 'organizationName', value: 'stubyard (development only)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: keys.privateKey, cert };
}

function createLeaf(caKey: forge.pki.rsa.PrivateKey, caCert: forge.pki.Certificate, names: string[]) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  // 825 days is the maximum lifetime macOS/iOS accept for TLS server certificates.
  cert.validity.notAfter = new Date(Date.now() + 825 * 24 * 3600 * 1000);
  cert.setSubject([{ name: 'commonName', value: 'stubyard' }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames = names.map((n) => (isIp(n) ? { type: 7, ip: n } : { type: 2, value: n }));
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { key: keys.privateKey, cert };
}

function isIp(n: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(n) || n.includes(':');
}

/**
 * 16 random bytes as an even-length hex string whose first byte is 0x40..0x7f: positive (high bit clear) and
 * never starting with 0x00, so its DER INTEGER encoding is always minimal. The old '0' + 30 hex digits form
 * (odd length) encoded as 00 00 <bytes> with only one zero stripped by forge, so whenever the first random
 * byte was 0x00 and the next < 0x80 (~1 in 512 certificates, two per fresh data dir) the INTEGER was
 * non-minimal and OpenSSL 3 rejected it with "asn1 encoding routines::illegal padding".
 */
export function randomSerial(): string {
  const bytes = crypto.randomBytes(16);
  bytes[0] = 0x40 | (bytes[0]! & 0x3f);
  return bytes.toString('hex');
}

/** The stored CA, or null when it is unreadable or OpenSSL rejects it. */
function loadCa(keyFile: string, certFile: string): { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate } | null {
  try {
    const keyPem = fs.readFileSync(keyFile, 'utf8');
    const certPem = fs.readFileSync(certFile, 'utf8');
    const x509 = new crypto.X509Certificate(certPem);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(keyPem))) return null;
    return { key: forge.pki.privateKeyFromPem(keyPem), cert: forge.pki.certificateFromPem(certPem) };
  } catch {
    return null;
  }
}

/** True when the stored leaf parses in OpenSSL, matches its key, was issued by the CA and is not about to expire. */
function leafUsable(keyFile: string, certFile: string, caCertFile: string): boolean {
  try {
    const leaf = new crypto.X509Certificate(fs.readFileSync(certFile, 'utf8'));
    const ca = new crypto.X509Certificate(fs.readFileSync(caCertFile, 'utf8'));
    if (!leaf.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8')))) return false;
    if (!leaf.verify(ca.publicKey)) return false;
    return new Date(leaf.validTo).getTime() - Date.now() >= 30 * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

function fingerprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex().toUpperCase().match(/.{2}/g)!.join(':');
}

function writePrivate(file: string, content: string): void {
  writeAtomic(file, content, 0o600);
}

/** Write via a temp file + rename so a concurrent reader never sees a half-written PEM. */
function writeAtomic(file: string, content: string, mode = 0o644): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
