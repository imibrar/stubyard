import forge from 'node-forge';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TlsMaterial {
  caCertPem: string;
  certPem: string;
  keyPem: string;
  names: string[];
  caFingerprint: string;
  caCreatedAt: string;
}

const DEFAULT_NAMES = ['localhost', '127.0.0.1', '::1', 'devhub', 'host.docker.internal'];

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

  let caKey: forge.pki.rsa.PrivateKey;
  let caCert: forge.pki.Certificate;
  if (fs.existsSync(caKeyFile) && fs.existsSync(caCertFile)) {
    caKey = forge.pki.privateKeyFromPem(fs.readFileSync(caKeyFile, 'utf8'));
    caCert = forge.pki.certificateFromPem(fs.readFileSync(caCertFile, 'utf8'));
  } else {
    ({ key: caKey, cert: caCert } = createCa());
    writePrivate(caKeyFile, forge.pki.privateKeyToPem(caKey));
    fs.writeFileSync(caCertFile, forge.pki.certificateToPem(caCert));
    // A new CA invalidates any existing leaf certificate.
    fs.rmSync(certFile, { force: true });
  }

  const names = [...new Set([...DEFAULT_NAMES, ...extraNames].map((n) => n.trim().toLowerCase()).filter(Boolean))].sort();
  const previous = fs.existsSync(namesFile) ? (JSON.parse(fs.readFileSync(namesFile, 'utf8')) as string[]) : [];
  const needLeaf =
    !fs.existsSync(certFile) ||
    !fs.existsSync(keyFile) ||
    JSON.stringify(previous) !== JSON.stringify(names) ||
    expiresWithinDays(forge.pki.certificateFromPem(fs.readFileSync(certFile, 'utf8')), 30);

  if (needLeaf) {
    const { key, cert } = createLeaf(caKey, caCert, names);
    writePrivate(keyFile, forge.pki.privateKeyToPem(key));
    fs.writeFileSync(certFile, forge.pki.certificateToPem(cert));
    fs.writeFileSync(namesFile, JSON.stringify(names));
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
    { name: 'commonName', value: `devhub local CA (${os.hostname()})` },
    { name: 'organizationName', value: 'devhub (development only)' },
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
  cert.setSubject([{ name: 'commonName', value: 'devhub' }]);
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

function randomSerial(): string {
  // Positive serial: first hex digit < 8.
  return '0' + forge.util.bytesToHex(forge.random.getBytesSync(15));
}

function expiresWithinDays(cert: forge.pki.Certificate, days: number): boolean {
  return cert.validity.notAfter.getTime() - Date.now() < days * 24 * 3600 * 1000;
}

function fingerprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex().toUpperCase().match(/.{2}/g)!.join(':');
}

function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600 });
}
