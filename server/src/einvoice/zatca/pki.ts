import forge from 'node-forge';
import crypto, { KeyObject, X509Certificate } from 'node:crypto';

/**
 * The fake ZATCA PKI: a secp256k1 CA, CSR parsing with proof-of-possession, CSID certificate issue and the
 * certificate digests the invoice checks need. Structures are built and read with forge's ASN.1 module (forge's
 * certificate helpers are RSA-only); keys, ECDSA and certificate checks use node:crypto.
 */

const asn1 = forge.asn1;
type Asn1 = forge.asn1.Asn1;

export const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  extensionRequest: '1.2.840.113549.1.9.14',
  template: '1.3.6.1.4.1.311.20.2',
  subjectAltName: '2.5.29.17',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  basicConstraints: '2.5.29.19',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  C: '2.5.4.6',
  OU: '2.5.4.11',
  O: '2.5.4.10',
  CN: '2.5.4.3',
  organizationIdentifier: '2.5.4.97',
  SN: '2.5.4.4',
  UID: '0.9.2342.19200300.100.1.1',
  title: '2.5.4.12',
  registeredAddress: '2.5.4.26',
  businessCategory: '2.5.4.15',
} as const;

const NAME_BY_OID: Record<string, string> = Object.fromEntries(Object.entries(OID).map(([k, v]) => [v, k]));

export type ZatcaTemplate = 'TSTZATCA-Code-Signing' | 'PREZATCA-Code-Signing' | 'ZATCA-Code-Signing';

export interface ParsedCsr {
  pem: string;
  der: Buffer;
  /** Subject attributes by short name (C, OU, O, CN, organizationIdentifier, ...). */
  subject: Record<string, string>;
  /** Attributes of the SAN dirName (SN, UID, title, registeredAddress, businessCategory). */
  san: Record<string, string>;
  egsSerial: string | null;
  vatNumber: string | null;
  invoiceTypes: string | null;
  template: string | null;
  /** 'secp256k1', 'prime256v1', or whatever node reports for another key. */
  curve: string;
  publicKey: KeyObject;
  signatureAlgorithm: string;
  /** The CSR signature verifies with its own public key. */
  popValid: boolean;
  /** Raw DER pieces reused when issuing a certificate. */
  subjectDer: Buffer;
  spkiDer: Buffer;
  sanExtValue: Buffer | null;
}

export interface Ca {
  keyPem: string;
  certPem: string;
}

export interface CertInfo {
  serial: string;
  subject: string;
  issuer: string;
  egsSerial: string | null;
  vatNumber: string | null;
  template: string | null;
  notAfter: Date;
  /** SubjectPublicKeyInfo DER (QR tag 8). */
  spkiDer: Buffer;
  /** The certificate's ECDSA signature bytes, DER (QR tag 9). */
  signatureValue: Buffer;
}

// --- low-level DER helpers (shared with csr.ts) ---

const bin = (b: Buffer): string => b.toString('binary');
const buf = (s: string): Buffer => Buffer.from(s, 'binary');

export const der = (node: Asn1): Buffer => buf(asn1.toDer(node).getBytes());
const fromDer = (b: Buffer): Asn1 => asn1.fromDer(bin(b), { decodeBitStrings: false, strict: true } as never);
const seq = (items: Asn1[]): Asn1 => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, items);
const set = (items: Asn1[]): Asn1 => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, items);
const oid = (o: string): Asn1 => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(o).getBytes());
const octets = (b: Buffer): Asn1 => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, bin(b));
const bits = (b: Buffer, unused = 0): Asn1 =>
  asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BITSTRING, false, String.fromCharCode(unused) + bin(b));
const bool = (v: boolean): Asn1 => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, v ? '\xff' : '\x00');
const int = (b: Buffer): Asn1 => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, bin(b));
const ctx = (n: number, items: Asn1[]): Asn1 => asn1.create(asn1.Class.CONTEXT_SPECIFIC, n, true, items);
export const embed = (b: Buffer): Asn1 => fromDer(b);

/** A string value: PrintableString for country codes, UTF8String otherwise. */
export function str(value: string, printable = false): Asn1 {
  return printable
    ? asn1.create(asn1.Class.UNIVERSAL, asn1.Type.PRINTABLESTRING, false, value)
    : asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTF8, false, forge.util.encodeUtf8(value));
}

/** A Name with one attribute per RDN, in the given order. Empty values are left out. */
export function name(attrs: Array<[string, string | undefined]>): Asn1 {
  return seq(
    attrs
      .filter((a): a is [string, string] => !!a[1])
      .map(([o, v]) => set([seq([oid(o), str(v, o === OID.C)])])),
  );
}

export const ecdsaSha256AlgId = (): Asn1 => seq([oid(OID.ecdsaWithSha256)]);

export function extension(o: string, value: Asn1 | Buffer, critical = false): Asn1 {
  const v = Buffer.isBuffer(value) ? value : der(value);
  return seq(critical ? [oid(o), bool(true), octets(v)] : [oid(o), octets(v)]);
}

/** SAN with a single directoryName ([4], explicit since Name is a CHOICE). */
export const sanDirName = (n: Asn1): Asn1 => seq([ctx(4, [n])]);

export const templateValue = (template: string): Asn1 => str(template, true);

/** A signed structure: SEQUENCE { tbs, ecdsa-with-SHA256, BIT STRING signature }. */
export function signed(tbs: Asn1, key: KeyObject | string): Buffer {
  const tbsDer = der(tbs);
  const sig = crypto.sign('sha256', tbsDer, key);
  return der(seq([embed(tbsDer), ecdsaSha256AlgId(), bits(sig)]));
}

export function toPem(d: Buffer, label: string): string {
  const body = d.toString('base64').replace(/.{1,64}/g, '$&\n');
  return `-----BEGIN ${label}-----\n${body}-----END ${label}-----\n`;
}

/** The raw DER of each child of the constructed element at the start of `b`. */
function children(b: Buffer): Buffer[] {
  const head = (at: number): { len: number; hdr: number } => {
    let len = b[at + 1];
    let hdr = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i];
      hdr += n;
    }
    return { len, hdr };
  };
  const outer = head(0);
  const out: Buffer[] = [];
  let at = outer.hdr;
  const end = outer.hdr + outer.len;
  while (at < end) {
    const { len, hdr } = head(at);
    out.push(b.subarray(at, at + hdr + len));
    at += hdr + len;
  }
  return out;
}

function readString(node: Asn1): string {
  const v = node.value as string;
  if (node.type === asn1.Type.UTF8) return forge.util.decodeUtf8(v);
  return v;
}

/** Name → { shortName or OID: value }. */
function readName(node: Asn1): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rdn of node.value as Asn1[]) {
    for (const atv of rdn.value as Asn1[]) {
      const [t, v] = atv.value as Asn1[];
      const o = asn1.derToOid(t.value as string);
      out[NAME_BY_OID[o] ?? o] = readString(v);
    }
  }
  return out;
}

/** Extensions SEQUENCE → { oid: extnValue DER }. */
function readExtensions(node: Asn1): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const ext of node.value as Asn1[]) {
    const parts = ext.value as Asn1[];
    const o = asn1.derToOid(parts[0].value as string);
    out[o] = buf(parts[parts.length - 1].value as string);
  }
  return out;
}

/** The dirName attributes of a SAN extension value. */
function readSan(value: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const gn of fromDer(value).value as Asn1[]) {
    if (gn.tagClass === asn1.Class.CONTEXT_SPECIFIC && gn.type === 4) Object.assign(out, readName((gn.value as Asn1[])[0]));
  }
  return out;
}

const readTemplate = (value: Buffer | undefined): string | null => (value ? readString(fromDer(value)) : null);

/** PEM, base64 of a PEM (what clients send as `{csr}`), or base64 DER → DER. */
function decodeInput(input: string, label: RegExp): Buffer {
  let text = input.trim();
  if (!text.includes('-----BEGIN')) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    const asText = decoded.toString('latin1');
    if (!asText.includes('-----BEGIN')) return decoded;
    text = asText;
  }
  const m = text.match(new RegExp(`-----BEGIN (${label.source})-----([\\s\\S]*?)-----END \\1-----`));
  if (!m) throw new Error('no PEM block of the expected type');
  return Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
}

const spkiKey = (spkiDer: Buffer): KeyObject => crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

// --- CSR ---

/** Parse a PKCS#10 CSR (PEM or base64 of PEM) and check its proof of possession. Throws on malformed input. */
export function parseCsr(pemOrBase64: string): ParsedCsr {
  const d = decodeInput(pemOrBase64, /(?:NEW )?CERTIFICATE REQUEST/);
  let root: Asn1;
  try {
    root = fromDer(d);
  } catch (e) {
    throw new Error(`CSR is not valid DER: ${(e as Error).message}`);
  }
  const [criRaw] = children(d);
  const [, subjectRaw, spkiDer] = children(criRaw);
  const [cri, algId, sigBits] = root.value as Asn1[];
  const [, subjectNode, , attrs] = cri.value as Asn1[];
  const publicKey = spkiKey(spkiDer);
  const signatureAlgorithm = asn1.derToOid((algId.value as Asn1[])[0].value as string);
  const sig = buf(sigBits.value as string).subarray(1);

  let exts: Record<string, Buffer> = {};
  for (const attr of (attrs?.value as Asn1[] | undefined) ?? []) {
    const [t, values] = attr.value as Asn1[];
    if (asn1.derToOid(t.value as string) === OID.extensionRequest) exts = readExtensions((values.value as Asn1[])[0]);
  }
  const sanExtValue = exts[OID.subjectAltName] ?? null;
  const san = sanExtValue ? readSan(sanExtValue) : {};
  const subject = readName(subjectNode);

  let popValid = false;
  try {
    popValid = signatureAlgorithm === OID.ecdsaWithSha256 && crypto.verify('sha256', criRaw, publicKey, sig);
  } catch {
    popValid = false;
  }

  return {
    pem: toPem(d, 'CERTIFICATE REQUEST'),
    der: d,
    subject,
    san,
    egsSerial: san.SN ?? null,
    vatNumber: san.UID ?? subject.organizationIdentifier ?? null,
    invoiceTypes: san.title ?? null,
    template: readTemplate(exts[OID.template]),
    curve: publicKey.asymmetricKeyDetails?.namedCurve ?? publicKey.asymmetricKeyType ?? 'unknown',
    publicKey,
    signatureAlgorithm,
    popValid,
    subjectDer: subjectRaw,
    spkiDer,
    sanExtValue,
  };
}

// --- certificates ---

interface CertParts {
  der: Buffer;
  tbs: Asn1;
  subjectDer: Buffer;
  exts: Record<string, Buffer>;
  signatureValue: Buffer;
}

function certParts(certPem: string): CertParts {
  const d = decodeInput(certPem, /CERTIFICATE/);
  const [tbs, , sigBits] = fromDer(d).value as Asn1[];
  const fields = tbs.value as Asn1[];
  const off = fields[0].tagClass === asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  const tbsRaw = children(d)[0];
  const extNode = fields.find((f) => f.tagClass === asn1.Class.CONTEXT_SPECIFIC && f.type === 3);
  return {
    der: d,
    tbs,
    subjectDer: children(tbsRaw)[off + 4],
    exts: extNode ? readExtensions((extNode.value as Asn1[])[0]) : {},
    signatureValue: buf(sigBits.value as string).subarray(1),
  };
}

const utc = (d: Date): Asn1 => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.UTCTIME, false, asn1.dateToUtcTime(d));

/** A positive serial of 16 random bytes, or the given hex. */
function serialBytes(hex?: string): Buffer {
  if (hex) {
    const b = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
  }
  const b = crypto.randomBytes(16);
  b[0] = (b[0] & 0x7f) | 0x01;
  return b;
}

function tbsCertificate(o: {
  serial: Buffer;
  issuer: Asn1;
  subject: Asn1;
  spkiDer: Buffer;
  notBefore: Date;
  notAfter: Date;
  extensions: Asn1[];
}): Asn1 {
  return seq([
    ctx(0, [int(Buffer.from([2]))]),
    int(o.serial),
    ecdsaSha256AlgId(),
    o.issuer,
    seq([utc(o.notBefore), utc(o.notAfter)]),
    o.subject,
    embed(o.spkiDer),
    ctx(3, [seq(o.extensions)]),
  ]);
}

const CA_CN = 'stubyard fake ZATCA CA';

/** A new self-signed secp256k1 CA (10 years). */
export function createCa(): Ca {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const subject = name([
    [OID.C, 'SA'],
    [OID.O, 'stubyard'],
    [OID.CN, CA_CN],
  ]);
  const now = new Date();
  const tbs = tbsCertificate({
    serial: serialBytes(),
    issuer: subject,
    subject: embed(der(subject)),
    spkiDer: publicKey.export({ format: 'der', type: 'spki' }),
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + 3650 * 86_400_000),
    extensions: [
      extension(OID.basicConstraints, seq([bool(true)]), true),
      // keyCertSign (bit 5) and cRLSign (bit 6)
      extension(OID.keyUsage, bits(Buffer.from([0x06]), 1), true),
    ],
  });
  return {
    keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    certPem: toPem(signed(tbs, privateKey), 'CERTIFICATE'),
  };
}

/** Issue a CSID certificate for a CSR: its subject, key and SAN, the template extension, signed by the CA. */
export function issueCert(
  ca: Ca,
  csr: ParsedCsr | string,
  opts: { template?: string; days?: number; serial?: string } = {},
): string {
  const req = typeof csr === 'string' ? parseCsr(csr) : csr;
  const template = opts.template ?? req.template ?? 'TSTZATCA-Code-Signing';
  const now = new Date();
  const extensions: Asn1[] = [];
  if (req.sanExtValue) extensions.push(extension(OID.subjectAltName, req.sanExtValue));
  extensions.push(
    extension(OID.template, templateValue(template)),
    // digitalSignature (bit 0)
    extension(OID.keyUsage, bits(Buffer.from([0x80]), 7), true),
    extension(OID.extKeyUsage, seq([oid(OID.clientAuth)])),
  );
  const tbs = tbsCertificate({
    serial: serialBytes(opts.serial),
    issuer: embed(certParts(ca.certPem).subjectDer),
    subject: embed(req.subjectDer),
    spkiDer: req.spkiDer,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + (opts.days ?? 365) * 86_400_000),
    extensions,
  });
  return toPem(signed(tbs, ca.keyPem), 'CERTIFICATE');
}

const pemBody = (certPem: string): string => certParts(certPem).der.toString('base64');

/** The CSID `binarySecurityToken`: base64 of the base64 DER certificate. */
export const binarySecurityToken = (certPem: string): string => Buffer.from(pemBody(certPem)).toString('base64');

/** The certificate PEM inside a `binarySecurityToken`. */
export function certFromToken(token: string): string {
  const b64 = Buffer.from(token.trim(), 'base64').toString('latin1').trim();
  if (b64.includes('-----BEGIN')) return toPem(decodeInput(b64, /CERTIFICATE/), 'CERTIFICATE');
  return toPem(Buffer.from(b64, 'base64'), 'CERTIFICATE');
}

/** The ZATCA certificate digest quirk: base64 of the hex text of sha256(DER). */
export const certHash = (certPem: string): string =>
  Buffer.from(crypto.createHash('sha256').update(certParts(certPem).der).digest('hex')).toString('base64');

/** The standard digest: base64 of the raw sha256(DER). */
export const certHashRaw = (certPem: string): string =>
  crypto.createHash('sha256').update(certParts(certPem).der).digest('base64');

/**
 * Every CertDigest a client may send. zatca-xml-js hashes the base64 body text of the PEM rather than the DER, so
 * the `*Text` variants cover that.
 */
export function certHashVariants(certPem: string): { hex: string; raw: string; hexText: string; rawText: string } {
  const text = pemBody(certPem);
  const h = (data: Buffer | string) => crypto.createHash('sha256').update(data);
  return {
    hex: certHash(certPem),
    raw: certHashRaw(certPem),
    hexText: Buffer.from(h(text).digest('hex')).toString('base64'),
    rawText: h(text).digest('base64'),
  };
}

/** The certificate was signed by the CA and names it as issuer. */
export function certIssuedBy(certPem: string, ca: Ca | string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    const caCert = new X509Certificate(typeof ca === 'string' ? ca : ca.certPem);
    return cert.checkIssued(caCert) && cert.verify(caCert.publicKey);
  } catch {
    return false;
  }
}

export function certInfo(certPem: string): CertInfo {
  const parts = certParts(certPem);
  const x = new X509Certificate(parts.der);
  const san = parts.exts[OID.subjectAltName] ? readSan(parts.exts[OID.subjectAltName]) : {};
  const subject = readName(fromDer(parts.subjectDer));
  return {
    serial: x.serialNumber.toLowerCase(),
    subject: x.subject,
    issuer: x.issuer,
    egsSerial: san.SN ?? null,
    vatNumber: san.UID ?? subject.organizationIdentifier ?? null,
    template: readTemplate(parts.exts[OID.template]),
    notAfter: new Date(x.validTo),
    spkiDer: x.publicKey.export({ format: 'der', type: 'spki' }),
    signatureValue: parts.signatureValue,
  };
}

// --- ECDSA ---

/** ECDSA-SHA256 over `data`; the DER signature, base64. */
export const ecdsaSign = (keyPem: string | KeyObject, data: Buffer | string): string =>
  crypto.sign('sha256', Buffer.from(data), keyPem).toString('base64');

/** Verify a base64 DER ECDSA-SHA256 signature with a certificate, a public key PEM or a KeyObject. */
export function ecdsaVerify(key: string | KeyObject, data: Buffer | string, sigB64: string): boolean {
  try {
    const pub =
      typeof key === 'string' && key.includes('CERTIFICATE') && !key.includes('REQUEST')
        ? new X509Certificate(key).publicKey
        : key;
    return crypto.verify('sha256', Buffer.from(data), pub, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
