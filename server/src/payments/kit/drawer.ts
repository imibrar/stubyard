import { esc } from '../../auth/pages.js';
import { MAGIC_CARDS, OUTCOMES } from '../engine.js';
import { t, type Locale } from './i18n.js';
import type { ExperienceMode } from './registry.js';
import { userSelect, type KitUser } from './fields.js';

/**
 * The "Test controls" drawer (a <details>, so it works without JS) and the always-visible test shortcuts.
 * The drawer sits inside form#pay: the test user (name=user), what Pay does (k_outcome → the Pay button value),
 * magic test cards, the other outcomes as submit buttons (stubyard-outcome-*), language, the classic view and
 * the fidelity note. Decline / Cancel stay reachable without opening it (Fable review, D3).
 */

export interface DrawerInput {
  locale: Locale;
  users: KitUser[];
  userId: string | null;
  open: boolean;
  /** Links relative to the page: the same page with a different view / language, the dashboard. */
  selfUrl: string;
  dashboardUrl: string;
  mode: ExperienceMode | null;
  timings: 'auto' | 'realistic' | 'fast';
  cards?: boolean;
  /** The "When you press Pay" choice to preselect (carried across the screens of a multi-step flow). */
  choice?: string | null;
}

const PAY_CHOICES = ['success', 'decline', 'decline:insufficient_funds', 'decline:expired_card', 'pending_then_success'] as const;
const MORE = OUTCOMES.filter((o) => !['success', 'decline', 'cancel'].includes(o));
const REASONS = ['insufficient_funds', 'expired_card', 'incorrect_cvc', 'processing_error'];

export function drawerHtml(d: DrawerInput): string {
  const L = d.locale;
  const fid = d.mode
    ? `<p class="k-fid"><b>${esc(d.mode.label)}</b><br>${esc(t(L, 'fidelityApi'))}: ${esc(t(L, d.mode.api))} · ${esc(t(L, 'fidelityScreens'))}: ${esc(t(L, d.mode.screens))}${d.mode.notes ? `<br>${esc(d.mode.notes)}` : ''}</p>${d.mode.steps?.length ? `<ol class="k-fid k-steps" data-testid="stubyard-fidelity-steps">${d.mode.steps.map((s) => `<li data-screens="${s.screens}">${esc(s.label)} <span class="k-ftag">${esc(t(L, s.screens))}</span></li>`).join('')}</ol>` : ''}`
    : '';
  const sep = d.selfUrl.includes('?') ? '&' : '?';
  return `<details class="k-drawer" id="k-drawer" data-testid="stubyard-drawer"${d.open ? ' open' : ''}><summary>${esc(t(L, 'testControls'))}</summary>
<div class="k-dbody" role="region" aria-label="${esc(t(L, 'testControls'))}">
${d.users.length ? `<h3 id="k-user-h">${esc(t(L, 'testUser'))}</h3>${userSelect(L, d.users, d.userId, { labelledBy: 'k-user-h' })}` : ''}
<h3 id="k-pay-h">${esc(t(L, 'payDoes'))}</h3><p class="k-hint" id="k-pay-hint">${esc(t(L, 'payDoesHint'))}</p><div role="radiogroup" aria-labelledby="k-pay-h" aria-describedby="k-pay-hint">${PAY_CHOICES.map((o, i) => `<label class="k-radio"><input type="radio" name="k_outcome" value="${o}"${(d.choice && (PAY_CHOICES as readonly string[]).includes(d.choice) ? d.choice === o : i === 0) ? ' checked' : ''} data-testid="stubyard-pay-choice-${o.replace(':', '-')}"><span><span class="mono" dir="ltr">${esc(o === 'success' ? t(L, 'outSuccess') : o)}</span>${o === 'success' ? '' : `<small>${esc(t(L, 'testCardFirst'))}</small>`}</span></label>`).join('')}</div>
${d.cards !== false ? `<h3>${esc(t(L, 'testCards'))}</h3><div class="k-chips">${MAGIC_CARDS.map((c) => `<button type="button" class="k-chip" data-card="${c.number}" title="${esc(c.label)}">${esc(c.id)}</button>`).join('')}</div>` : ''}
<h3>${esc(t(L, 'otherOutcomes'))}</h3><div class="k-outs">${MORE.map((o) => `<button type="submit" name="outcome" value="${o}" formnovalidate title="${o}" data-testid="stubyard-outcome-${o}">${o}</button>`).join('')}${REASONS.map((r) => `<button type="submit" name="outcome" value="decline:${r}" formnovalidate title="decline:${r}" data-testid="stubyard-outcome-decline-${r}">decline:${r}</button>`).join('')}</div>
<h3>${esc(t(L, 'language'))}</h3><div class="k-links"><a href="${esc(d.selfUrl + sep)}stubyard_lang=en" lang="en" data-testid="stubyard-lang-en">English</a><a href="${esc(d.selfUrl + sep)}stubyard_lang=ar" lang="ar" data-testid="stubyard-lang-ar">العربية</a></div>
${L === 'ar' ? `<p class="k-hint">${esc(t(L, 'arNote'))}</p>` : ''}
<h3>${esc(t(L, 'view'))}</h3><div class="k-links"><a href="${esc(d.selfUrl + sep)}ui=classic" data-testid="stubyard-classic-view">${esc(t(L, 'classicView'))}</a><a href="${esc(d.dashboardUrl)}" target="_blank" rel="noopener">${esc(t(L, 'openStubyard'))}</a></div>
${fid ? `<h3>${esc(t(L, 'fidelity'))}</h3>${fid}` : ''}
<h3>${esc(t(L, 'timings'))}</h3><p class="k-hint" id="k-timings">${esc(d.timings === 'fast' ? t(L, 'timingsFast') : t(L, 'timingsReal'))}</p>
</div></details>`;
}

/**
 * The test shortcuts under the banner: Decline and Cancel as submit buttons (testids kept from the classic page),
 * and the forced-outcome notice with Continue when a rule or header decides.
 */
export function quickHtml(L: Locale, o: { cancellable: boolean; forced: { outcome: string; via: string } | null }): string {
  const forced = o.forced
    ? `<div class="k-forced" data-testid="stubyard-forced"><b>${esc(t(L, 'forced', { via: o.forced.via, outcome: o.forced.outcome }))}</b><span>${esc(t(L, 'forcedHint'))}</span><button type="submit" class="k-qbtn" name="outcome" value="success" formnovalidate data-testid="stubyard-continue">${esc(t(L, 'continue'))}</button></div>`
    : '';
  return `<div class="k-quick" role="group" aria-label="${esc(t(L, 'testShortcuts'))}"><span class="k-qlabel">${esc(t(L, 'testShortcuts'))}:</span><button type="submit" class="k-qbtn bad" name="outcome" value="decline" formnovalidate data-testid="stubyard-decline">${esc(t(L, 'decline'))}</button>${o.cancellable ? `<button type="submit" class="k-qbtn" name="outcome" value="cancel" formnovalidate data-testid="stubyard-cancel">${esc(t(L, 'cancelReturn'))}</button>` : ''}${forced}</div>`;
}
