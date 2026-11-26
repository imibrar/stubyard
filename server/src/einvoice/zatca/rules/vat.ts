import type { Element } from '@xmldom/xmldom';
import { add, div, mul, parse, places, round, sub, toString, tryParse, type Dec } from '../dec.js';
import type { RuleContext, RuleModule } from '../validate.js';
import { children, find, text } from '../xml.js';
import { ruleFinding, type RuleFinding } from './catalog.js';

/**
 * Phase 2, VAT arithmetic: line net, line VAT and RoundingAmount, the document sums, the VAT breakdown per category,
 * the category rate and exemption rules, and the totals chain (BT-106 → BT-115). Exact BigInt decimals (dec.ts), no floats.
 *
 * Rounding (docs/plans/research-zatca.md, "Totals" and "Line net and rounding"): half-up at 2 decimals;
 * - line net = round2(price / base quantity × quantity) − line allowances + line charges;
 * - line VAT = round2(line net × rate / 100); the line RoundingAmount = line net + line VAT;
 * - category VAT = round2(category taxable × rate / 100), rounded once per category, not summed from the lines;
 * - each total is checked against the stated values it is built from (BT-109 from BT-106..108, BT-112 from BT-109 and
 *   BT-110, ...), so one wrong figure is reported once and does not repeat in every total after it.
 *
 * Tolerances: the research gives none. Amounts are compared exactly at 2 decimals, because the sample generator's own
 * break "line-vat" is a single halala (0.01) and must be caught. The one exception is the category VAT: BR-CO-17 (a
 * warning) fires on any difference, BR-S-09 (an error) only when the difference is more than one halala, so a client
 * that sums the rounded line VAT per category instead of rounding once gets the warning and not a rejection.
 *
 * Missing or non-numeric elements are not reported here when another module owns them (structure, BR-14 and so on); a
 * check whose inputs are absent is skipped.
 */
export const VAT_TOLERANCE = {
  /** Line net, line VAT, RoundingAmount, the document sums and totals: exact. */
  exact: 0n,
  /** BR-S-09 (category S VAT amount): more than this difference is an error (BR-CO-17 warns on any difference). */
  categoryError: parse('0.01'),
} as const;

type Code = string;

/** Category codes: the rate rule, the taxable-amount sum, the tax amount and the exemption reason code rule. */
const CATEGORY: Record<string, { rate: Code; taxable: Code; tax: Code; reason: Code | null }> = {
  S: { rate: 'BR-S-05', taxable: 'BR-S-08', tax: 'BR-S-09', reason: null },
  Z: { rate: 'BR-Z-05', taxable: 'BR-Z-08', tax: 'BR-Z-09', reason: 'BR-KSA-69' },
  E: { rate: 'BR-E-05', taxable: 'BR-E-08', tax: 'BR-E-09', reason: 'BR-KSA-23' },
  O: { rate: 'BR-O-05', taxable: 'BR-O-08', tax: 'BR-O-09', reason: 'BR-KSA-83' },
};

/**
 * Exemption reason codes per category (ZATCA's VATEX-SA list). Assumed: the research notes name the rules but not the
 * list; this is the list of the ZATCA e-invoicing data dictionary as known to stubyard.
 */
export const EXEMPTION_REASON_CODES: Record<'Z' | 'E' | 'O', readonly string[]> = {
  Z: ['VATEX-SA-32', 'VATEX-SA-33', 'VATEX-SA-34-1', 'VATEX-SA-34-2', 'VATEX-SA-34-3', 'VATEX-SA-34-4', 'VATEX-SA-34-5', 'VATEX-SA-35', 'VATEX-SA-36', 'VATEX-SA-EDU', 'VATEX-SA-HEA'],
  E: ['VATEX-SA-29', 'VATEX-SA-29-7', 'VATEX-SA-30'],
  O: ['VATEX-SA-OOS'],
};

const ZERO = 0n;
const ONE = parse(1);
const HUNDRED = parse(100);

const abs = (d: Dec): Dec => (d < ZERO ? -d : d);
const show = (d: Dec): string => toString(d, Math.max(2, places(d)));
const differs = (a: Dec, b: Dec, tol: Dec = VAT_TOLERANCE.exact): boolean => abs(sub(a, b)) > tol;
const pct = (net: Dec, percent: Dec): Dec => round(div(mul(net, percent), HUNDRED), 2);

function value(el: Element | null): Dec | null {
  if (!el) return null;
  const r = tryParse(el.textContent ?? '');
  return r.ok ? r.value : null;
}

/** An element's amount in a VAT breakdown or total, with its BR-DEC check. */
class Reader {
  constructor(private out: RuleFinding[]) {}

  /** The decimal at `rel` below `parent` (null when absent or not a number); more than 2 decimals gives `decCode`. */
  amount(parent: Element, rel: string, path: string, decCode?: Code): Dec | null {
    const d = value(find(parent, rel));
    if (d !== null && decCode && places(d) > 2) {
      this.out.push(ruleFinding(decCode, `${path} has ${places(d)} decimals (${show(d)}); amounts have at most 2.`, path));
    }
    return d;
  }
}

interface Cat {
  id: string | null;
  percent: Dec | null;
  /** Grouping key of lines, allowances and subtotals: category and rate. */
  key: string | null;
  el: Element | null;
}

function category(el: Element | null): Cat {
  const id = el ? (text(el, 'cbc:ID')?.trim() || null) : null;
  const percent = el ? value(find(el, 'cbc:Percent')) : null;
  return { id, percent, key: id ? `${id}|${percent ?? ZERO}` : null, el };
}

const isCharge = (ac: Element): boolean => text(ac, 'cbc:ChargeIndicator')?.trim().toLowerCase() === 'true';

const label = (c: Cat): string => `${c.id ?? '?'} at ${c.percent === null ? 'no rate' : `${show(c.percent)}%`}`;

export const vatRules: RuleModule = (ctx: RuleContext): RuleFinding[] => {
  const out: RuleFinding[] = [];
  const rd = new Reader(out);
  const { root } = ctx;
  const push = (code: Code, message: string, path?: string): void => {
    out.push(ruleFinding(code, message, path));
  };

  /** The rate rule of a category (BR-S-05, BR-Z-05, BR-E-05, BR-O-05). */
  const rateRule = (c: Cat, path: string): void => {
    const rules = c.id ? CATEGORY[c.id] : undefined;
    if (!rules) return;
    const p = `${path}/cbc:Percent`;
    if (c.id === 'S') {
      if (c.percent === null || c.percent <= ZERO) push(rules.rate, `VAT category S needs a rate above 0, got ${c.percent === null ? 'none' : show(c.percent)}.`, p);
    } else if (c.id === 'O') {
      if (c.percent !== null && c.percent !== ZERO) push(rules.rate, `VAT category O carries no rate (a 0 is accepted), got ${show(c.percent)}.`, p);
    } else if (c.percent === null || c.percent !== ZERO) {
      push(rules.rate, `VAT category ${c.id} needs the rate 0, got ${c.percent === null ? 'none' : show(c.percent)}.`, p);
    }
  };

  // --- lines ---
  const lineNets: Dec[] = [];
  /** Σ line nets (+ charges − allowances at document level) per category and rate. */
  const taxable = new Map<string, { cat: Cat; sum: Dec }>();
  const bump = (c: Cat, by: Dec): void => {
    if (!c.key || !c.id || !CATEGORY[c.id]) return;
    const g = taxable.get(c.key) ?? { cat: c, sum: ZERO };
    g.sum = add(g.sum, by);
    taxable.set(c.key, g);
  };

  for (const [i, line] of children(root, 'cac:InvoiceLine').entries()) {
    const p = `cac:InvoiceLine[${i + 1}]`;
    const net = rd.amount(line, 'cbc:LineExtensionAmount', `${p}/cbc:LineExtensionAmount`, 'BR-DEC-23');
    const cat = category(find(line, 'cac:Item/cac:ClassifiedTaxCategory'));
    rateRule(cat, `${p}/cac:Item/cac:ClassifiedTaxCategory`);

    let allowances = ZERO;
    let charges = ZERO;
    for (const [k, ac] of children(line, 'cac:AllowanceCharge').entries()) {
      const charge = isCharge(ac);
      const a = rd.amount(ac, 'cbc:Amount', `${p}/cac:AllowanceCharge[${k + 1}]/cbc:Amount`, charge ? 'BR-DEC-25' : 'BR-DEC-24');
      if (a === null) continue;
      if (charge) charges = add(charges, a);
      else allowances = add(allowances, a);
    }
    const qty = value(find(line, 'cbc:InvoicedQuantity'));
    const price = value(find(line, 'cac:Price/cbc:PriceAmount'));
    const base = value(find(line, 'cac:Price/cbc:BaseQuantity')) ?? ONE;
    const priceEl = find(line, 'cac:Price');
    if (priceEl) {
      for (const [k, ac] of children(priceEl, 'cac:AllowanceCharge').entries()) {
        const q = `${p}/cac:Price/cac:AllowanceCharge[${k + 1}]`;
        rd.amount(ac, 'cbc:Amount', `${q}/cbc:Amount`, 'BR-DEC-27');
        rd.amount(ac, 'cbc:BaseAmount', `${q}/cbc:BaseAmount`, 'BR-DEC-28');
      }
    }

    if (net !== null) {
      lineNets.push(net);
      bump(cat, net);
      if (qty !== null && price !== null && base > ZERO) {
        const gross = round(base === ONE ? mul(price, qty) : div(mul(price, qty), base), 2);
        const expected = add(sub(gross, allowances), charges);
        if (differs(net, expected)) {
          push('BR-24', `The net amount of line ${i + 1} is ${show(net)}, expected ${show(expected)} (price ${show(price)} × quantity ${show(qty)}${base === ONE ? '' : ` / ${show(base)}`} = ${show(gross)}, minus allowances ${show(allowances)}, plus charges ${show(charges)}).`, `${p}/cbc:LineExtensionAmount`);
        }
      }
    }

    // line VAT (BR-KSA-51), the amount with VAT (BR-KSA-52) and RoundingAmount (BR-KSA-53)
    const taxEl = find(line, 'cac:TaxTotal/cbc:TaxAmount');
    const roundEl = find(line, 'cac:TaxTotal/cbc:RoundingAmount');
    const vat = value(taxEl);
    const rounding = value(roundEl);
    const rate = cat.percent ?? (cat.id && cat.id !== 'S' ? ZERO : null);
    if (vat === null) {
      push('BR-KSA-51', `Line ${i + 1} has no usable VAT amount (cac:TaxTotal/cbc:TaxAmount).`, `${p}/cac:TaxTotal/cbc:TaxAmount`);
    } else if (net !== null && rate !== null) {
      const expected = pct(net, rate);
      if (differs(vat, expected)) {
        push('BR-KSA-51', `The VAT amount of line ${i + 1} is ${show(vat)}, expected ${show(expected)} (net ${show(net)} × ${show(rate)}%).`, `${p}/cac:TaxTotal/cbc:TaxAmount`);
      }
    }
    if (rounding === null) {
      push('BR-KSA-52', `Line ${i + 1} has no usable amount with VAT (cac:TaxTotal/cbc:RoundingAmount).`, `${p}/cac:TaxTotal/cbc:RoundingAmount`);
    } else if (net !== null && vat !== null && differs(rounding, add(net, vat))) {
      push('BR-KSA-53', `The RoundingAmount of line ${i + 1} is ${show(rounding)}, expected ${show(add(net, vat))} (net ${show(net)} + VAT ${show(vat)}).`, `${p}/cac:TaxTotal/cbc:RoundingAmount`);
    }
  }

  // --- document allowances and charges ---
  let allowanceSum = ZERO;
  let chargeSum = ZERO;
  for (const [i, ac] of children(root, 'cac:AllowanceCharge').entries()) {
    const p = `cac:AllowanceCharge[${i + 1}]`;
    const charge = isCharge(ac);
    const a = rd.amount(ac, 'cbc:Amount', `${p}/cbc:Amount`, charge ? 'BR-DEC-12' : 'BR-DEC-10');
    rd.amount(ac, 'cbc:BaseAmount', `${p}/cbc:BaseAmount`, charge ? 'BR-DEC-13' : 'BR-DEC-11');
    if (a === null) continue;
    const cat = category(find(ac, 'cac:TaxCategory'));
    rateRule(cat, `${p}/cac:TaxCategory`);
    if (charge) {
      chargeSum = add(chargeSum, a);
      bump(cat, a);
    } else {
      allowanceSum = add(allowanceSum, a);
      bump(cat, -a);
    }
  }

  // --- document totals ---
  const lmt = find(root, 'cac:LegalMonetaryTotal');
  const lp = 'cac:LegalMonetaryTotal';
  const bt106 = lmt ? rd.amount(lmt, 'cbc:LineExtensionAmount', `${lp}/cbc:LineExtensionAmount`, 'BR-DEC-09') : null;
  const bt107 = lmt ? rd.amount(lmt, 'cbc:AllowanceTotalAmount', `${lp}/cbc:AllowanceTotalAmount`, 'BR-DEC-14') : null;
  const bt108 = lmt ? rd.amount(lmt, 'cbc:ChargeTotalAmount', `${lp}/cbc:ChargeTotalAmount`, 'BR-DEC-15') : null;
  const bt109 = lmt ? rd.amount(lmt, 'cbc:TaxExclusiveAmount', `${lp}/cbc:TaxExclusiveAmount`, 'BR-DEC-16') : null;
  const bt112 = lmt ? rd.amount(lmt, 'cbc:TaxInclusiveAmount', `${lp}/cbc:TaxInclusiveAmount`, 'BR-DEC-19') : null;
  const bt113 = lmt ? rd.amount(lmt, 'cbc:PrepaidAmount', `${lp}/cbc:PrepaidAmount`, 'BR-DEC-20') : null;
  const bt114 = lmt ? rd.amount(lmt, 'cbc:PayableRoundingAmount', `${lp}/cbc:PayableRoundingAmount`) : null;
  const bt115 = lmt ? rd.amount(lmt, 'cbc:PayableAmount', `${lp}/cbc:PayableAmount`) : null;

  const linesSum = lineNets.reduce(add, ZERO);
  if (lmt) {
    if (bt106 !== null && differs(bt106, linesSum)) {
      push('BR-CO-10', `The sum of line net amounts (BT-106) is ${show(bt106)}, the lines add up to ${show(linesSum)}.`, `${lp}/cbc:LineExtensionAmount`);
    }
    if (differs(bt107 ?? ZERO, allowanceSum)) {
      push('BR-CO-11', `The sum of document allowances (BT-107) is ${show(bt107 ?? ZERO)}, the allowances add up to ${show(allowanceSum)}.`, `${lp}/cbc:AllowanceTotalAmount`);
    }
    if (differs(bt108 ?? ZERO, chargeSum)) {
      push('BR-CO-12', `The sum of document charges (BT-108) is ${show(bt108 ?? ZERO)}, the charges add up to ${show(chargeSum)}.`, `${lp}/cbc:ChargeTotalAmount`);
    }
    if (bt109 !== null) {
      const exp = add(sub(bt106 ?? linesSum, bt107 ?? allowanceSum), bt108 ?? chargeSum);
      if (differs(bt109, exp)) {
        push('BR-CO-13', `The total without VAT (BT-109) is ${show(bt109)}, expected ${show(exp)} (lines ${show(bt106 ?? linesSum)} − allowances ${show(bt107 ?? allowanceSum)} + charges ${show(bt108 ?? chargeSum)}).`, `${lp}/cbc:TaxExclusiveAmount`);
      }
    }
  }

  // --- VAT totals and the breakdown ---
  const taxTotals = children(root, 'cac:TaxTotal').map((el, i) => ({ el, path: `cac:TaxTotal[${i + 1}]`, subtotals: children(el, 'cac:TaxSubtotal') }));
  const withSubtotals = taxTotals.filter((t) => t.subtotals.length > 0);
  const without = taxTotals.filter((t) => t.subtotals.length === 0);
  const main = withSubtotals[0] ?? null;
  const bt110 = main ? rd.amount(main.el, 'cbc:TaxAmount', `${main.path}/cbc:TaxAmount`, 'BR-DEC-17') : null;
  const currency = text(root, 'cbc:DocumentCurrencyCode')?.trim() ?? null;
  const taxCurrency = text(root, 'cbc:TaxCurrencyCode')?.trim() ?? null;

  const sarTotal = without[0] ?? null;
  const bt111 = sarTotal ? rd.amount(sarTotal.el, 'cbc:TaxAmount', `${sarTotal.path}/cbc:TaxAmount`, 'BR-DEC-18') : null;
  if (!sarTotal && taxCurrency && main) {
    push('BR-53', `The VAT accounting currency ${taxCurrency} is present but the invoice has no TaxTotal in that currency (BT-111, a TaxTotal without TaxSubtotal).`, 'cac:TaxTotal');
  } else if (sarTotal && bt111 !== null && bt110 !== null && currency === 'SAR' && differs(bt111, bt110)) {
    push('BR-CO-14', `The SAR TaxTotal (BT-111) is ${show(bt111)} but the invoice VAT (BT-110) is ${show(bt110)}; with the document currency SAR they are the same amount.`, `${sarTotal.path}/cbc:TaxAmount`);
  }

  let subtotalTax = ZERO;
  const seen = new Set<string>();
  let subtotalCount = 0;
  for (const t of withSubtotals) {
    for (const [j, sub1] of t.subtotals.entries()) {
      subtotalCount++;
      const p = `${t.path}/cac:TaxSubtotal[${j + 1}]`;
      const txb = rd.amount(sub1, 'cbc:TaxableAmount', `${p}/cbc:TaxableAmount`);
      const tax = rd.amount(sub1, 'cbc:TaxAmount', `${p}/cbc:TaxAmount`);
      if (tax !== null) subtotalTax = add(subtotalTax, tax);
      const cat = category(find(sub1, 'cac:TaxCategory'));
      const rules = cat.id ? CATEGORY[cat.id] : undefined;
      if (!rules || !cat.key) continue;
      seen.add(cat.key);
      rateRule(cat, `${p}/cac:TaxCategory`);

      if (txb !== null) {
        const expected = taxable.get(cat.key)?.sum ?? ZERO;
        if (differs(txb, expected)) {
          push(rules.taxable, `The taxable amount of VAT category ${label(cat)} is ${show(txb)}, expected ${show(expected)} (line nets − allowances + charges of that category).`, `${p}/cbc:TaxableAmount`);
        }
        if (tax !== null) {
          const expTax = pct(txb, cat.percent ?? ZERO);
          if (differs(tax, expTax)) {
            push('BR-CO-17', `The VAT amount of category ${label(cat)} is ${show(tax)}, expected ${show(expTax)} (${show(txb)} × ${show(cat.percent ?? ZERO)}% rounded to 2 decimals).`, `${p}/cbc:TaxAmount`);
            const limit = cat.id === 'S' ? VAT_TOLERANCE.categoryError : VAT_TOLERANCE.exact;
            if (differs(tax, expTax, limit)) {
              push(rules.tax, cat.id === 'S'
                ? `The VAT amount of category S is ${show(tax)}, expected ${show(expTax)} (${show(txb)} × ${show(cat.percent ?? ZERO)}%).`
                : `The VAT amount of category ${cat.id} is ${show(tax)}, expected 0.`, `${p}/cbc:TaxAmount`);
            }
          }
        }
      }

      if (rules.reason && cat.id && cat.id !== 'S' && cat.el) {
        const allowed = EXEMPTION_REASON_CODES[cat.id as 'Z' | 'E' | 'O'];
        const code = text(cat.el, 'cbc:TaxExemptionReasonCode')?.trim() || null;
        if (!code || !allowed.includes(code)) {
          push(rules.reason, code
            ? `The exemption reason code ${code} is not allowed for VAT category ${cat.id}; use one of ${allowed.join(', ')}.`
            : `A VAT category ${cat.id} breakdown needs an exemption reason code (${allowed.join(', ')}).`, `${p}/cac:TaxCategory/cbc:TaxExemptionReasonCode`);
        }
        if (cat.id === 'E' && !(text(cat.el, 'cbc:TaxExemptionReason')?.trim())) {
          push('BR-KSA-24', 'A VAT category E breakdown needs an exemption reason text.', `${p}/cac:TaxCategory/cbc:TaxExemptionReason`);
        }
      }
    }
  }

  // A category used by lines, allowances or charges without its own breakdown (only once there is a breakdown at all).
  if (subtotalCount > 0) {
    for (const [key, g] of taxable) {
      if (seen.has(key)) continue;
      const rules = CATEGORY[g.cat.id!];
      push(rules.taxable, `The invoice uses VAT category ${label(g.cat)} (${show(g.sum)}) but has no breakdown for it.`, 'cac:TaxTotal/cac:TaxSubtotal');
    }
  }

  if (main && bt110 !== null && subtotalCount > 0 && differs(bt110, subtotalTax)) {
    push('BR-CO-14', `The invoice VAT (BT-110) is ${show(bt110)}, the category VAT amounts add up to ${show(subtotalTax)}.`, `${main.path}/cbc:TaxAmount`);
  }

  // BT-110 for the totals below: the breakdown total, or the only TaxTotal when there is no breakdown.
  const vatForTotals = bt110 ?? (taxTotals.length === 1 ? value(find(taxTotals[0].el, 'cbc:TaxAmount')) : null);
  if (lmt && bt112 !== null) {
    const base = bt109 ?? (bt106 !== null || lineNets.length ? add(sub(bt106 ?? linesSum, bt107 ?? allowanceSum), bt108 ?? chargeSum) : null);
    if (base !== null && vatForTotals !== null) {
      const exp = add(base, vatForTotals);
      if (differs(bt112, exp)) {
        push('BR-CO-15', `The total with VAT (BT-112) is ${show(bt112)}, expected ${show(exp)} (total without VAT ${show(base)} + VAT ${show(vatForTotals)}).`, `${lp}/cbc:TaxInclusiveAmount`);
      }
    }
  }
  if (lmt && bt115 !== null && bt112 !== null) {
    const exp = add(sub(bt112, bt113 ?? ZERO), bt114 ?? ZERO);
    if (differs(bt115, exp)) {
      push('BR-CO-16', `The amount due (BT-115) is ${show(bt115)}, expected ${show(exp)} (total with VAT ${show(bt112)} − prepaid ${show(bt113 ?? ZERO)} + rounding ${show(bt114 ?? ZERO)}).`, `${lp}/cbc:PayableAmount`);
    }
  }

  return out;
};
