import { finding, type EinvoiceLintFinding } from '../../lint.js';
import { FIRST_PIH, isFirstPihVariant } from '../hash.js';
import type { ChainState, ExtractedInvoice, RuleModule, ValidateInput } from '../validate.js';
import { ruleFinding, type RuleFinding } from './catalog.js';

/**
 * The ICV / PIH chain of an EGS unit.
 *
 * - chainChecks (both modes, run by validateInvoice): the stubyard-only lint against the chain head
 *   (einv.pih-mismatch, einv.icv-gap / icv-repeat / icv-reset) per config.chainCheck, the `stubyard-chain` error when
 *   chainCheck is 'error'; firstPihLint: einv.first-pih-variant.
 * - chainRules (phase 2 module): the ZATCA value rules of the ICV and PIH, BR-KSA-33 (ICV digits only) and BR-KSA-26
 *   (PIH is base64 of a SHA-256 digest, or the first-PIH constant). Whether the ICV / PIH reference is there at all
 *   (BR-KSA-34 / BR-KSA-61, also an empty value) is the structure module's.
 */

/** Code of the error added when config.chainCheck is 'error' (stubyard's own, not a ZATCA code). */
export const CHAIN_ERROR_CODE = 'stubyard-chain';

const PIH_PATH = 'cac:AdditionalDocumentReference[ID=PIH]';
const ICV_PATH = 'cac:AdditionalDocumentReference[ID=ICV]';
const B64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/;

const label = (number: string | null, icv: number | null) => `${number ?? '(no number)'} (ICV ${icv ?? '?'})`;

/** ICV / PIH chain findings (einv.*) for an invoice of a known EGS chain. */
export function chainFindings(x: ExtractedInvoice, chain: ChainState): EinvoiceLintFinding[] {
  const out: EinvoiceLintFinding[] = [];
  const me = label(x.number, x.icv);
  if (chain.lastHash === null) {
    if (x.pih !== null && x.pih !== FIRST_PIH && !isFirstPihVariant(x.pih)) {
      out.push(finding('einv.pih-mismatch', `PIH of invoice ${me} is not the first-PIH value of an empty chain: expected ${FIRST_PIH}, got ${x.pih}`, { path: PIH_PATH }));
    }
    return out;
  }
  const prev = label(chain.lastNumber ?? null, chain.lastIcv);
  if (x.pih !== chain.lastHash) {
    out.push(finding('einv.pih-mismatch', `PIH of invoice ${me} is not the hash of invoice ${prev}: expected ${chain.lastHash}, got ${x.pih ?? '(none)'}`, { path: PIH_PATH }));
  }
  if (x.icv !== null && chain.lastIcv !== null) {
    const path = ICV_PATH;
    if (x.icv === chain.lastIcv) out.push(finding('einv.icv-repeat', `ICV ${x.icv} of invoice ${x.number ?? '(no number)'} was already used by invoice ${prev}`, { path }));
    else if (x.icv < chain.lastIcv) out.push(finding('einv.icv-reset', `ICV of invoice ${x.number ?? '(no number)'} went back from ${chain.lastIcv} to ${x.icv}`, { path }));
    else if (x.icv > chain.lastIcv + 1) out.push(finding('einv.icv-gap', `ICV of invoice ${x.number ?? '(no number)'} jumped from ${chain.lastIcv} to ${x.icv}: expected ${chain.lastIcv + 1}`, { path }));
  }
  return out;
}

/** Same hash and ICV as the chain head: a resend of the head (no chain findings, the chain doesn't advance). */
export const isRetryOfHead = (x: ExtractedInvoice, chain: ChainState | null): boolean =>
  !!chain && chain.lastHash !== null && chain.lastHash === x.computedHash && chain.lastIcv === x.icv;

/** einv.first-pih-variant (both modes, with or without a chain). */
export function firstPihLint(x: ExtractedInvoice): EinvoiceLintFinding[] {
  if (!x.pih || !isFirstPihVariant(x.pih)) return [];
  return [finding('einv.first-pih-variant', `The PIH ${x.pih} is a wrong spelling of the first-PIH value; ZATCA's is ${FIRST_PIH} (base64 of the hex text of sha256("0"))`, { path: PIH_PATH })];
}

/** The chain lint of one invoice (both modes) and the `stubyard-chain` errors when config.chainCheck is 'error'. */
export function chainChecks(x: ExtractedInvoice, input: ValidateInput): { findings: RuleFinding[]; lint: EinvoiceLintFinding[] } {
  const findings: RuleFinding[] = [];
  const lint: EinvoiceLintFinding[] = [];
  const chain = input.chain ?? null;
  if (chain && !isRetryOfHead(x, chain) && input.config.chainCheck !== 'off') {
    const found = chainFindings(x, chain);
    lint.push(...found);
    if (input.config.chainCheck === 'error') {
      for (const f of found) if (f.severity === 'error') findings.push({ code: CHAIN_ERROR_CODE, category: 'KSA', severity: 'error', message: f.message, ...(f.path ? { path: f.path } : {}) });
    }
  }
  return { findings, lint };
}

/** base64 of 32 bytes (a SHA-256 digest). */
function isB64Sha256(v: string): boolean {
  return B64_STRICT.test(v) && v.length % 4 === 0 && Buffer.from(v, 'base64').length === 32;
}

/** Phase 2: BR-KSA-33 (ICV digits only) and BR-KSA-26 (PIH format). Missing or empty values are left to structure. */
export const chainRules: RuleModule = (ctx) => {
  const out: RuleFinding[] = [];
  const x = ctx.extracted;
  if (x.icvText !== null && !/^\d+$/.test(x.icvText)) {
    out.push(ruleFinding('BR-KSA-33', `The invoice counter value (ICV) "${x.icvText}" shall contain digits only.`, `${ICV_PATH}/cbc:UUID`));
  }
  // A first-PIH variant (raw digest or bare hex) is einv.first-pih-variant, not a format error.
  if (x.pih !== null && x.pih !== FIRST_PIH && !isFirstPihVariant(x.pih) && !isB64Sha256(x.pih)) {
    out.push(ruleFinding('BR-KSA-26', `The previous invoice hash (PIH) "${x.pih}" is not the base64 of a SHA-256 digest (32 bytes) or the first-PIH value ${FIRST_PIH}.`, `${PIH_PATH}/cac:Attachment/cbc:EmbeddedDocumentBinaryObject`));
  }
  return out;
};
