import forge from 'node-forge';
import { KeyObject, createPublicKey } from 'node:crypto';
import { OID, embed, extension, name, sanDirName, signed, templateValue, toPem, type ZatcaTemplate } from './pki.js';

/**
 * A ZATCA EGS CSR as the SDKs build it: subject C, OU, O, CN; an extension request with the certificate template
 * (1.3.6.1.4.1.311.20.2) and a SAN dirName carrying SN (EGS serial), UID (VAT), title (invoice types),
 * registeredAddress and businessCategory; signed with ECDSA-SHA256.
 */

const asn1 = forge.asn1;

export interface CsrInput {
  privateKey: KeyObject;
  commonName: string;
  vatNumber: string;
  /** "1-Manufacturer|2-Model|3-Serial" */
  egsSerial: string;
  orgUnit: string;
  org: string;
  country?: string;
  /** TSCZ flags, e.g. "1100" (standard and simplified). */
  invoiceTypes?: string;
  address: string;
  industry: string;
  template: ZatcaTemplate | string;
}

export function buildCsr(input: CsrInput): string {
  const subject = name([
    [OID.C, input.country ?? 'SA'],
    [OID.OU, input.orgUnit],
    [OID.O, input.org],
    [OID.CN, input.commonName],
  ]);
  const san = name([
    [OID.SN, input.egsSerial],
    [OID.UID, input.vatNumber],
    [OID.title, input.invoiceTypes ?? '1100'],
    [OID.registeredAddress, input.address],
    [OID.businessCategory, input.industry],
  ]);
  const extensions = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    extension(OID.template, templateValue(input.template)),
    extension(OID.subjectAltName, sanDirName(san)),
  ]);
  const extensionRequest = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID.extensionRequest).getBytes()),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [extensions]),
  ]);
  const spki = createPublicKey(input.privateKey).export({ format: 'der', type: 'spki' });
  const cri = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, '\x00'),
    subject,
    embed(spki),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [extensionRequest]),
  ]);
  return toPem(signed(cri, input.privateKey), 'CERTIFICATE REQUEST');
}
