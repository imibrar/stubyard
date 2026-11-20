import { randomInt } from 'node:crypto';
import type { Hub } from '../hub.js';
import { extractOtp } from '../messages/extract.js';
import { replyOptions } from '../messages/simulator.js';
import type { Channel } from '../providers/catalog.js';
import type { Message } from '../repos/messages.js';
import type { Project } from '../repos/projects.js';
import type { Run } from '../repos/runs.js';
import type { TestUser } from '../repos/users.js';
import { HttpError, normalizeEmail, normalizePhone } from '../util.js';
import { matchRule, matchSummary, normalizeChannel, normalizeMatch, type MatchResult, type MatchSubject } from './match.js';
import { AutoReplyRepo, type RuleFields } from './repo.js';
import { render, TEMPLATE_VARIABLES, variablesOf, type TemplateVars } from './template.js';
import type { PersonaFireInfo } from '../personas/service.js';
import { FIRE_STATUSES, type AutoReplyFire, type AutoReplyRule, type AutoReplySpec, type FirePlan, type FireStatus, type ReplyPlan } from './types.js';

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o: J, k: string) => o[k] !== undefined;

/** Outbound statuses that mean "the user got it" and can trigger a rule (bounced, failed, dropped, scheduled, rejected and complained never do). */
export const TRIGGER_STATUSES = ['delivered'];
/** Loop guard: more than LOOP_LIMIT fires of one rule for one user within LOOP_WINDOW_MS disables the rule. */
export const LOOP_LIMIT = 20;
export const LOOP_WINDOW_MS = 60_000;
/** Slow loops (one round trip every few seconds) never trip LOOP_LIMIT: more than HOURLY_LIMIT fires of one rule for one user within an hour disable it too. */
export const HOURLY_LIMIT = 200;
export const HOURLY_WINDOW_MS = 3_600_000;
/** disabledReason values set by the loop guards (project reset and enabling the rule re-arm it). */
export const LOOP_REASONS = ['loop', 'loop-hourly'];
const loopWarning = (reason: string | null) =>
  reason === 'loop'
    ? `Disabled by the loop guard: more than ${LOOP_LIMIT} replies to one user within ${LOOP_WINDOW_MS / 1000} s. Check that your app does not answer every reply; enable the rule again to re-arm it.`
    : reason === 'loop-hourly'
      ? `Disabled by the loop guard: more than ${HOURLY_LIMIT} replies to one user within an hour. Check that your app does not answer every reply; enable the rule again to re-arm it.`
      : null;
export const MAX_DELAY_MS = 7 * 86_400_000;
export const MAX_JITTER_MS = 86_400_000;
export const FIRE_JOB = 'autoreply.fire';
const REPLY_CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];

/** The message a rule reacts to, as the reply engine sees it (a stored message, or an inline one in /test). */
export interface TriggerView extends MatchSubject {
  id: string | null;
  /** WhatsApp: buttons / list rows the message offers (for button "#1" = the first one). */
  buttons?: { id: string; title: string }[];
}

export interface DecideContext {
  project: Project;
  trigger: TriggerView;
  user: TestUser;
  captures: Record<string, string>;
}

/**
 * What to reply. The single place that decides the reply for a matched rule: scripted templates now,
 * AI personas later (round 4) plug in here. null = send nothing.
 */
export function decideReply(rule: Pick<AutoReplyRule, 'reply'>, ctx: DecideContext): { plan: ReplyPlan | null; warnings: string[] } {
  const r = rule.reply;
  const t = ctx.trigger;
  const warnings: string[] = [];
  const channel = r.channel ?? t.channel;
  const same = channel === t.channel;
  const vars: TemplateVars = {
    otp: t.otp ?? extractOtp([t.subject, t.body].filter(Boolean).join('\n'), ctx.project.settings.otpRegex),
    links: t.links,
    subject: t.subject,
    body: t.body,
    from: t.from,
    to: t.to,
    channel: t.channel,
    user: { name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone, role: ctx.user.role },
    captures: ctx.captures,
  };
  const field = (tpl: string | undefined, name: string, html = false) => {
    if (tpl === undefined || tpl === null) return null;
    const out = render(tpl, vars, { html, field: name });
    warnings.push(...out.warnings);
    return out.text;
  };
  const plan: ReplyPlan = { channel, text: field(r.text, 'reply.text') ?? '' };
  plan.instance = r.instance ?? (same ? t.instanceSlug : null);
  if (channel === 'email') {
    const threaded = same && r.thread !== false && !!t.id;
    plan.subject = field(r.subject, 'reply.subject') || (!threaded && same && t.subject ? (/^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`) : null);
    plan.html = field(r.html, 'reply.html', true);
    if (threaded) plan.inReplyTo = t.id;
    else if (same && t.from) plan.to = t.from;
  }
  if (channel === 'whatsapp' && r.button) {
    plan.button = field(r.button, 'reply.button');
    const nth = /^#(\d+)$/.exec(plan.button?.trim() ?? '');
    if (nth && same) {
      const b = (t.buttons ?? [])[Number(nth[1]) - 1];
      if (b) plan.button = b.id;
      else warnings.push(`reply.button ${nth[0]}: the message has ${(t.buttons ?? []).length} button(s)`);
    }
    if (same && t.id) plan.contextMessageId = t.id;
  }
  if (!plan.text.trim() && !plan.button && !plan.html) {
    warnings.push('The reply rendered empty, so nothing is sent');
    return { plan: null, warnings };
  }
  return { plan, warnings };
}

const STATIC_VARS = new Set(['otp', 'link', 'subject', 'body', 'from', 'to', 'channel', 'now', 'uuid', 'user.name', 'user.email', 'user.phone', 'user.role']);
const knownVariable = (n: string) => STATIC_VARS.has(n) || /^links\.\d+$/.test(n) || /^random\.digits:\d{1,2}$/.test(n) || /^\$\d+$/.test(n) || /^(body|subject)\.[A-Za-z0-9_]+$/.test(n);

/** hub.autoReplies: scripted auto-replies. Fake test users answer by themselves when the app messages them. */
export class AutoReplyService {
  readonly repo: AutoReplyRepo;

  constructor(private hub: Hub) {
    this.repo = new AutoReplyRepo(hub.db);
    hub.scheduler.register(FIRE_JOB, async (job) => {
      await this.fire(String(job.payload.fireId ?? ''));
    });
    hub.bus.subscribe((e) => {
      if (e.type !== 'message.created' && e.type !== 'message.updated') return;
      try {
        this.onMessage(e.data as Message);
      } catch {
        /* an auto-reply bug must never break message capture */
      }
    });
    this.markLost();
    this.failInterrupted();
  }

  /** Boot: a fire still "sending" was cut off by a crash or restart mid-send; it can never finish now. */
  failInterrupted(): number {
    const stuck = this.repo.firesWithStatus('sending');
    for (const f of stuck) {
      this.repo.finish(f.id, { status: 'failed', error: 'interrupted: stubyard stopped while the reply was being sent' });
      this.changed(f.projectId, { fire: f.id, status: 'failed' });
    }
    return stuck.length;
  }

  changed(projectId: string, data: J = {}): void {
    this.hub.bus.publish({ type: 'autoreplies.changed', projectId, data });
  }

  /** Pending fires whose job is gone after a restart: failed "lost" (the scheduled_jobs row survives a normal restart). */
  markLost(): number {
    const lost = this.repo.lostFires();
    for (const f of lost) {
      this.repo.finish(f.id, { status: 'failed', error: 'lost' });
      this.changed(f.projectId, { fire: f.id, status: 'failed' });
    }
    return lost.length;
  }

  // ------------------------------------------------------------------ trigger

  private instanceSlug(m: Pick<Message, 'providerInstanceId'>): string | null {
    return m.providerInstanceId ? (this.hub.providers.getById(m.providerInstanceId)?.slug ?? null) : null;
  }

  private triggerOf(m: Message, user: TestUser | null): TriggerView {
    return {
      id: m.id,
      channel: m.channel,
      to: m.to,
      from: m.from,
      subject: m.subject,
      body: m.bodyText,
      otp: m.otp,
      links: m.links,
      instanceSlug: this.instanceSlug(m),
      user: user ? { id: user.id, name: user.name, email: user.email, phone: user.phone, whatsapp: user.whatsapp, role: user.role } : null,
      buttons: m.channel === 'whatsapp' ? replyOptions(m).map((o) => ({ id: o.id, title: o.title })) : [],
    };
  }

  /** Bus handler: an outbound message reached a test user. Idempotent (UNIQUE rule + message). Returns the new fires. */
  onMessage(m: Message): AutoReplyFire[] {
    if (!m || m.direction !== 'outbound' || !m.testUserId || !TRIGGER_STATUSES.includes(m.status)) return [];
    const user = this.hub.users.get(m.projectId, m.testUserId);
    if (!user) return [];
    const rules = this.repo.rulesFor(m.projectId, m.runId);
    if (!rules.length) return [];
    const trigger = this.triggerOf(m, user);
    const created: AutoReplyFire[] = [];
    const disabled: string[] = [];
    this.hub.db.transaction(() => {
      for (const rule of rules) {
        if (!rule.enabled || rule.disabledReason) continue;
        if (rule.runId && rule.runId !== m.runId) continue;
        // Already fired for this message (message.created then message.updated): counts as matched.
        if (this.repo.hasFire(rule.id, m.id)) {
          if (rule.stop) break;
          continue;
        }
        if (rule.maxUses !== null && rule.uses >= rule.maxUses) continue;
        const res = matchRule(rule, trigger);
        if (!res.matched) continue;
        const loop =
          this.repo.recentFires(rule.id, user.id, new Date(Date.now() - LOOP_WINDOW_MS).toISOString()) >= LOOP_LIMIT
            ? 'loop'
            : this.repo.recentFires(rule.id, user.id, new Date(Date.now() - HOURLY_WINDOW_MS).toISOString()) >= HOURLY_LIMIT
              ? 'loop-hourly'
              : null;
        if (loop) {
          this.repo.updateRule(m.projectId, rule.id, { enabled: false, disabledReason: loop });
          disabled.push(rule.id);
          this.hub.personas?.onRuleDisabled(rule, user.id, loop);
          continue;
        }
        if (!this.repo.takeUse(rule.id)) continue;
        const delay = rule.delayMs + (rule.jitterMs > 0 ? randomInt(0, rule.jitterMs + 1) : 0);
        const fire = this.repo.insertFire({
          projectId: m.projectId,
          ruleId: rule.id,
          runId: rule.runId ?? m.runId,
          triggerMessageId: m.id,
          testUserId: user.id,
          status: 'pending',
          dueAt: new Date(Date.now() + delay).toISOString(),
          plan: { captures: res.captures, warnings: [] },
        });
        if (!fire) continue;
        // Always through the scheduler (also for 0 ms): the provider's HTTP answer goes out before the inbound webhook.
        const jobId = this.hub.scheduler.schedule(FIRE_JOB, { fireId: fire.id }, { projectId: m.projectId, delayMs: delay });
        this.repo.setJob(fire.id, jobId);
        created.push({ ...fire, jobId });
        if (rule.stop) break;
      }
    })();
    for (const id of disabled) this.changed(m.projectId, { rule: id, disabled: this.repo.ruleById(id)?.disabledReason ?? 'loop' });
    for (const f of created) this.changed(m.projectId, { fire: f.id, rule: f.ruleId, status: 'pending' });
    return created;
  }

  /**
   * What to reply: a persona rule asks hub.personas (an LLM call, async), every other rule renders its template
   * (decideReply, sync). skip / fail carry the reason for a fire that sends nothing.
   */
  async decide(
    rule: AutoReplyRule,
    ctx: DecideContext,
    o: { fireId: string | null; dryRun: boolean; message: Message | null },
  ): Promise<{ plan: ReplyPlan | null; warnings: string[]; persona?: PersonaFireInfo; skip?: string; fail?: string }> {
    if (!rule.reply.persona) return decideReply(rule, ctx);
    if (!this.hub.personas) return { plan: null, warnings: [], skip: 'AI personas are not available' };
    if (!o.message) return { plan: null, warnings: [], skip: 'A persona needs a stored message (pass a message id)' };
    const r = await this.hub.personas.reply({ rule, project: ctx.project, message: o.message, trigger: ctx.trigger, user: ctx.user, fireId: o.fireId, dryRun: o.dryRun });
    return {
      plan: r.outcome === 'send' ? r.plan : null,
      warnings: r.warnings,
      ...(r.persona ? { persona: r.persona } : {}),
      ...(r.outcome === 'skip' ? { skip: r.reason ?? 'Nothing to send' } : {}),
      ...(r.outcome === 'fail' ? { fail: r.reason ?? 'The persona failed' } : {}),
    };
  }

  // ------------------------------------------------------------------ fire

  /** Send the reply of one pending fire (job handler, /flush). Never throws; returns the fire as it ends. */
  async fire(fireId: string): Promise<AutoReplyFire | null> {
    const f = this.repo.fireById(fireId);
    if (!f || f.status !== 'pending') return f;
    if (!this.repo.claim(f.id, 'pending', 'sending')) return this.repo.fireById(f.id);
    const done = (p: Parameters<AutoReplyRepo['finish']>[1]) => {
      this.repo.finish(f.id, p);
      this.changed(f.projectId, { fire: f.id, rule: f.ruleId, status: p.status });
      return this.repo.fireById(f.id);
    };
    const skip = (why: string) => done({ status: 'skipped', error: why });
    try {
      const rule = this.repo.ruleById(f.ruleId);
      const project = this.hub.projects.get(f.projectId);
      if (!rule || !project) return skip('The rule was deleted');
      if (!rule.enabled) return skip(LOOP_REASONS.includes(rule.disabledReason ?? '') ? 'The rule was disabled by the loop guard' : 'The rule was disabled before the reply was due');
      const trigger = this.hub.messages.get(f.triggerMessageId);
      if (!trigger || trigger.projectId !== project.id) return skip('The message that triggered the rule is gone (project reset or run purged)');
      const user = f.testUserId ? this.hub.users.get(project.id, f.testUserId) : null;
      if (!user) return skip('The test user is gone');
      if (f.runId) {
        const run = this.hub.runs.repo.get(f.runId);
        if (!run || run.status !== 'active') return skip('The test run was stopped');
      }
      const d = await this.decide(rule, { project, trigger: this.triggerOf(trigger, user), user, captures: f.plan.captures }, { fireId: f.id, dryRun: false, message: trigger });
      const { plan, warnings } = d;
      const stored: FirePlan = { ...f.plan, warnings, ...(plan ? { rendered: plan } : {}), ...(d.persona ? { persona: d.persona } : {}) };
      if (d.fail) return done({ status: 'failed', plan: stored, error: d.fail });
      if (!plan) return done({ status: 'skipped', plan: stored, error: d.skip ?? warnings.at(-1) ?? 'Nothing to send' });
      try {
        const res = await this.hub.simulator.reply(project, user, {
          channel: plan.channel,
          text: plan.text,
          instance: plan.instance ?? null,
          button: plan.button ?? null,
          contextMessageId: plan.contextMessageId ?? null,
          subject: plan.subject ?? null,
          html: plan.html ?? null,
          inReplyTo: plan.inReplyTo ?? null,
          to: plan.to ?? null,
        });
        const persona = d.persona ? { persona: { personaId: d.persona.personaId, name: d.persona.name, threadId: d.persona.threadId, turnId: d.persona.turnId } } : {};
        const updated = this.hub.messages.updateStatus(res.message.id, { metadata: { autoReply: { ruleId: rule.id, ruleName: rule.name, triggerMessageId: trigger.id, fireId: f.id }, ...persona } });
        if (d.persona) this.hub.personas?.afterSend(d.persona, res.message.id);
        if (updated) this.hub.bus.publish({ type: 'message.updated', projectId: project.id, data: updated });
        if (!res.webhook) stored.warnings.push('No inbound URL is configured on the provider instance, so your app was not called');
        return done({
          status: 'sent',
          plan: stored,
          replyMessageId: res.message.id,
          webhookStatus: res.webhook?.status ?? null,
          webhookOk: res.webhook ? res.webhook.ok : null,
          error: res.webhook && !res.webhook.ok ? (res.webhook.error ?? `Your app answered HTTP ${res.webhook.status}`) : null,
        });
      } catch (err) {
        if (d.persona) this.hub.personas?.afterSend(d.persona, null, (err as Error).message);
        return done({ status: 'failed', plan: stored, error: (err as Error).message });
      }
    } catch (err) {
      return done({ status: 'failed', error: (err as Error).message });
    }
  }

  /** Fire every pending reply now, in due order (tests use this instead of sleeping). Only fires pending at the call. */
  async flush(project: Project, run: Run | null): Promise<AutoReplyFire[]> {
    const out: AutoReplyFire[] = [];
    for (const f of this.repo.pendingFires(project.id, run?.id ?? null)) {
      if (f.jobId) this.hub.scheduler.cancel(f.jobId);
      const r = await this.fire(f.id);
      if (r) out.push(r);
    }
    return out;
  }

  cancelFire(project: Project, id: string): AutoReplyFire {
    const f = this.repo.getFire(project.id, id);
    if (!f) throw new HttpError(404, `Auto-reply fire "${id}" not found`);
    if (f.status !== 'pending') throw new HttpError(409, `The fire is ${f.status}; only pending fires can be cancelled`);
    if (!this.repo.claim(f.id, 'pending', 'cancelled')) throw new HttpError(409, 'The reply is being sent right now');
    if (f.jobId) this.hub.scheduler.cancel(f.jobId);
    this.repo.finish(f.id, { status: 'cancelled', error: 'Cancelled' });
    this.changed(project.id, { fire: f.id, status: 'cancelled' });
    return this.repo.getFire(project.id, f.id)!;
  }

  private cancelPending(fires: AutoReplyFire[], why: string): number {
    let n = 0;
    for (const f of fires) {
      if (!this.repo.claim(f.id, 'pending', 'cancelled')) continue;
      if (f.jobId) this.hub.scheduler.cancel(f.jobId);
      this.repo.finish(f.id, { status: 'cancelled', error: why });
      n++;
    }
    return n;
  }

  /** Long-poll for a fire that finished (default status sent | failed). */
  async waitFire(project: Project, q: { ruleId?: string; status?: string[]; after?: string; runId?: string; testUserId?: string }, timeoutMs: number): Promise<AutoReplyFire | null> {
    const status = q.status?.length ? q.status : ['sent', 'failed'];
    const find = () => this.repo.listFires(project.id, { ruleId: q.ruleId, runId: q.runId, testUserId: q.testUserId, after: q.after, status, limit: 1 })[0] ?? null;
    const now = find();
    if (now || timeoutMs <= 0) return now;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: AutoReplyFire | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve(v);
      };
      const unsub = this.hub.bus.subscribe((e) => {
        if (e.type !== 'autoreplies.changed' || e.projectId !== project.id) return;
        const f = find();
        if (f) finish(f);
      });
      const timer = setTimeout(() => finish(find()), timeoutMs);
    });
  }

  // ------------------------------------------------------------------ rules

  private normalizeReply(v: unknown, ruleChannel: AutoReplyRule['channel'], project: Project | null): AutoReplySpec {
    if (!isObj(v)) throw new HttpError(400, 'reply must be an object like {"text": "{{otp}}"}');
    const known = ['text', 'subject', 'html', 'channel', 'instance', 'button', 'thread', 'persona', 'instruction'];
    for (const k of Object.keys(v)) if (!known.includes(k)) throw new HttpError(400, `reply.${k} is not a reply field (${known.join(', ')})`);
    const str = (k: string, max = 20_000) => {
      if (v[k] === undefined || v[k] === null || v[k] === '') return undefined;
      const s = String(v[k]);
      if (s.length > max) throw new HttpError(400, `reply.${k} is longer than ${max} characters`);
      return s;
    };
    const personaRef = str('persona', 200);
    if (personaRef !== undefined) return this.normalizePersonaReply(v, personaRef, project, str);
    const out: AutoReplySpec = { text: str('text') ?? '' };
    const subject = str('subject', 1000);
    const html = str('html');
    const instance = str('instance', 120);
    const button = str('button', 200);
    if (v.channel !== undefined && v.channel !== null && v.channel !== '') {
      const c = String(v.channel).toLowerCase();
      if (!REPLY_CHANNELS.includes(c as Channel)) throw new HttpError(400, 'reply.channel must be email, sms or whatsapp (or left out: the channel of the message)');
      out.channel = c as Channel;
    }
    const effective = out.channel ?? (ruleChannel === 'any' ? null : ruleChannel);
    if (subject !== undefined) out.subject = subject;
    if (html !== undefined) out.html = html;
    if (instance !== undefined) out.instance = instance;
    if (button !== undefined) {
      if (effective && effective !== 'whatsapp') throw new HttpError(400, 'reply.button is for WhatsApp replies');
      out.button = button;
    }
    if (v.thread !== undefined && v.thread !== null) {
      if (typeof v.thread !== 'boolean') throw new HttpError(400, 'reply.thread must be true or false');
      out.thread = v.thread;
    }
    if (str('instruction') !== undefined) throw new HttpError(400, 'reply.instruction is for persona replies (reply.persona)');
    if (!out.text?.trim() && !out.button && !out.html) throw new HttpError(400, 'reply.text is required (a template such as "{{otp}}"), reply.button for a WhatsApp button tap, or reply.persona for an AI persona');
    return out;
  }

  /** reply {persona, instruction?, channel?, instance?, thread?}: exactly one of text / button or persona. */
  private normalizePersonaReply(v: J, ref: string, project: Project | null, str: (k: string, max?: number) => string | undefined): AutoReplySpec {
    for (const k of ['text', 'button', 'subject', 'html']) if (str(k) !== undefined) throw new HttpError(400, `reply.${k} cannot be combined with reply.persona: the persona writes the reply`);
    if (!this.hub.personas) throw new HttpError(400, 'AI personas are not available');
    const p = project ? this.hub.personas.repo.get(project.id, ref) : null;
    if (!p) throw new HttpError(400, `reply.persona: persona "${ref}" not found (create it under Auto-replies → Personas)`);
    const out: AutoReplySpec = { persona: p.id };
    const instruction = str('instruction', 1000);
    if (instruction !== undefined) out.instruction = instruction;
    if (v.channel !== undefined && v.channel !== null && v.channel !== '') {
      const c = String(v.channel).toLowerCase();
      if (!REPLY_CHANNELS.includes(c as Channel)) throw new HttpError(400, 'reply.channel must be email, sms or whatsapp (or left out: the channel of the message)');
      out.channel = c as Channel;
    }
    const instance = str('instance', 120);
    if (instance !== undefined) out.instance = instance;
    if (v.thread !== undefined && v.thread !== null) {
      if (typeof v.thread !== 'boolean') throw new HttpError(400, 'reply.thread must be true or false');
      out.thread = v.thread;
    }
    return out;
  }

  private ms(input: J, msKey: string, secKeys: string[], max: number): number | undefined {
    let v: unknown = input[msKey];
    let scale = 1;
    if (v === undefined) {
      const k = secKeys.find((x) => input[x] !== undefined);
      if (k) (v = input[k]), (scale = 1000);
    }
    if (v === undefined) return undefined;
    if (v === null || v === '') return 0;
    const n = Number(v) * scale;
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${msKey} must be a number ≥ 0`);
    if (n > max) throw new HttpError(400, `${msKey} must be at most ${max} ms (${max / 86_400_000} days)`);
    return Math.round(n);
  }

  private fields(input: J, prev: AutoReplyRule | null, project: Project | null = null): Partial<RuleFields> {
    const f: Partial<RuleFields> = {};
    if (has(input, 'name')) f.name = String(input.name ?? '').trim().slice(0, 120) || (prev?.name ?? 'Auto-reply');
    if (has(input, 'channel')) f.channel = normalizeChannel(input.channel);
    const channel = f.channel ?? prev?.channel ?? 'any';
    if (has(input, 'match')) f.match = normalizeMatch(input.match);
    if (has(input, 'reply')) f.reply = this.normalizeReply(input.reply, channel, project);
    else if (f.channel && prev) f.reply = this.normalizeReply(prev.reply, channel, project);
    const d = this.ms(input, 'delayMs', ['delaySeconds', 'delay_seconds'], MAX_DELAY_MS);
    if (d !== undefined) f.delayMs = d;
    const jt = this.ms(input, 'jitterMs', ['jitterSeconds', 'jitter_seconds'], MAX_JITTER_MS);
    if (jt !== undefined) f.jitterMs = jt;
    const mu = has(input, 'maxUses') ? input.maxUses : input.max_uses;
    if (mu !== undefined) {
      if (mu === null || mu === '' || mu === 0 || mu === '0') f.maxUses = mu === null || mu === '' ? null : 0;
      else {
        const n = Number(mu);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'maxUses must be a whole number ≥ 0 (or null for unlimited)');
        f.maxUses = n;
      }
    }
    if (has(input, 'uses')) {
      const n = Number(input.uses);
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'uses must be a whole number ≥ 0');
      f.uses = n;
    }
    for (const k of ['enabled', 'stop'] as const) {
      if (!has(input, k)) continue;
      if (typeof input[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
      f[k] = input[k] as boolean;
    }
    if (f.enabled === true) f.disabledReason = null;
    if (has(input, 'position')) {
      const n = Number(input.position);
      if (!Number.isInteger(n)) throw new HttpError(400, 'position must be a whole number');
      f.position = n;
    }
    return f;
  }

  createRule(project: Project, input: J, run: Run | null): AutoReplyRule {
    if (!isObj(input)) throw new HttpError(400, 'Body must be a JSON object');
    if (!has(input, 'reply')) throw new HttpError(400, 'reply is required, e.g. {"text": "{{otp}}"}');
    const f = this.fields(input, null, project);
    const rule = this.repo.createRule(project.id, run?.id ?? null, {
      name: f.name ?? `Auto-reply ${this.repo.listRules(project.id, { all: true }).length + 1}`,
      position: f.position ?? this.repo.nextPosition(project.id, run?.id ?? null),
      enabled: f.enabled ?? true,
      channel: f.channel ?? 'any',
      match: f.match ?? {},
      reply: f.reply!,
      delayMs: f.delayMs ?? 0,
      jitterMs: f.jitterMs ?? 0,
      maxUses: f.maxUses ?? null,
      uses: f.uses ?? 0,
      stop: f.stop ?? true,
      disabledReason: null,
    });
    this.changed(project.id, { rule: rule.id, created: true });
    return rule;
  }

  requireRule(project: Project, id: string): AutoReplyRule {
    const r = this.repo.getRule(project.id, id);
    if (!r) throw new HttpError(404, `Auto-reply rule "${id}" not found`);
    return r;
  }

  updateRule(project: Project, id: string, input: J): AutoReplyRule {
    if (!isObj(input)) throw new HttpError(400, 'Body must be a JSON object');
    const prev = this.requireRule(project, id);
    const r = this.repo.updateRule(project.id, id, this.fields(input, prev, project))!;
    this.changed(project.id, { rule: id });
    return r;
  }

  deleteRule(project: Project, id: string): void {
    this.requireRule(project, id);
    for (const f of this.repo.listFires(project.id, { ruleId: id, status: ['pending'], limit: 500 })) if (f.jobId) this.hub.scheduler.cancel(f.jobId);
    this.repo.deleteRule(project.id, id);
    this.changed(project.id, { rule: id, deleted: true });
  }

  deleteRules(project: Project, run: Run | null): number {
    const scope = this.repo.listRules(project.id, run ? { runId: run.id } : {});
    for (const r of scope) for (const f of this.repo.listFires(project.id, { ruleId: r.id, status: ['pending'], limit: 500 })) if (f.jobId) this.hub.scheduler.cancel(f.jobId);
    const n = this.repo.deleteRules(project.id, run?.id ?? null);
    this.changed(project.id, { deleted: n });
    return n;
  }

  reorder(project: Project, ids: unknown, run: Run | null): AutoReplyRule[] {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new HttpError(400, 'ids must be an array of rule ids');
    const scope = this.repo.listRules(project.id, run ? { runId: run.id } : {});
    const known = new Set(scope.map((r) => r.id));
    for (const id of ids) if (!known.has(id)) throw new HttpError(400, `Rule "${id}" is not a ${run ? `rule of run ${run.key}` : 'project rule'}`);
    const order = [...(ids as string[]), ...scope.map((r) => r.id).filter((id) => !(ids as string[]).includes(id))];
    this.hub.db.transaction(() => order.forEach((id, i) => this.repo.updateRule(project.id, id, { position: i })))();
    this.changed(project.id, { reordered: true });
    return this.repo.listRules(project.id, run ? { runId: run.id } : {});
  }

  // ------------------------------------------------------------------ dry run

  /** POST /test: would this rule answer this message, with what? Nothing is stored or sent. */
  async test(project: Project, input: J): Promise<{ matched: boolean; reasons: string[]; notes: string[]; captures: Record<string, string>; plan: ReplyPlan | null; warnings: string[]; message: J; persona?: PersonaFireInfo }> {
    let rule: AutoReplyRule;
    if (typeof input.rule === 'string') rule = this.requireRule(project, input.rule);
    else if (isObj(input.rule)) {
      const f = this.fields({ reply: { text: '(test)' }, ...input.rule }, null, project);
      rule = { id: '(inline)', projectId: project.id, runId: null, name: f.name ?? 'inline', position: 0, enabled: f.enabled ?? true, channel: f.channel ?? 'any', match: f.match ?? {}, reply: f.reply!, delayMs: f.delayMs ?? 0, jitterMs: f.jitterMs ?? 0, maxUses: f.maxUses ?? null, uses: 0, stop: f.stop ?? true, disabledReason: null, createdAt: '', updatedAt: '' };
    } else throw new HttpError(400, 'rule is required: a rule id or an inline rule {channel, match, reply}');

    let trigger: TriggerView;
    let stored: Message | null = null;
    let user: TestUser | null;
    const notes: string[] = [];
    if (typeof input.message === 'string') {
      const m = this.hub.messages.get(input.message);
      if (!m || m.projectId !== project.id) throw new HttpError(404, `Message "${input.message}" not found`);
      stored = m;
      user = m.testUserId ? this.hub.users.get(project.id, m.testUserId) : null;
      trigger = this.triggerOf(m, user);
      if (m.direction !== 'outbound') notes.push('This is an inbound message: replies never trigger rules');
      else if (!TRIGGER_STATUSES.includes(m.status)) notes.push(`The message is ${m.status}: only delivered messages trigger rules`);
      if (rule.runId && rule.runId !== m.runId) notes.push('The rule belongs to a test run this message is not part of');
    } else if (isObj(input.message)) {
      const mm = input.message;
      const channel = String(mm.channel ?? (rule.channel === 'any' ? 'sms' : rule.channel)) as Channel;
      if (!REPLY_CHANNELS.includes(channel)) throw new HttpError(400, 'message.channel must be email, sms or whatsapp');
      const to = String(mm.to ?? '');
      user = mm.user ? this.hub.users.resolve(project.id, String(mm.user)) : to ? this.hub.messageService.matchUser(project.id, channel, to) : null;
      const body = mm.body === undefined || mm.body === null ? null : String(mm.body);
      const subject = mm.subject === undefined || mm.subject === null ? null : String(mm.subject);
      trigger = {
        id: null,
        channel,
        to: (channel === 'email' ? normalizeEmail(to) : normalizePhone(to)) ?? to ?? (user ? ((channel === 'email' ? user.email : user.phone) ?? '') : ''),
        from: mm.from === undefined || mm.from === null ? null : String(mm.from),
        subject,
        body,
        otp: extractOtp([subject, body].filter(Boolean).join('\n'), project.settings.otpRegex),
        links: [...(body ?? '').matchAll(/https?:\/\/[^\s<>"')]+/g)].map((x) => x[0]),
        instanceSlug: mm.instance ? String(mm.instance) : null,
        user: user ? { id: user.id, name: user.name, email: user.email, phone: user.phone, whatsapp: user.whatsapp, role: user.role } : null,
      };
      if (!user) notes.push('No test user has this address: a real message to it would not trigger any rule');
    } else throw new HttpError(400, 'message is required: a message id or {channel, to, from, subject, body}');

    if (!rule.enabled) notes.push(LOOP_REASONS.includes(rule.disabledReason ?? '') ? 'The rule is disabled by the loop guard' : 'The rule is disabled');
    if (rule.maxUses !== null && rule.uses >= rule.maxUses) notes.push(`The rule is used up (${rule.uses}/${rule.maxUses})`);
    const res: MatchResult = matchRule(rule, trigger);
    let plan: ReplyPlan | null = null;
    let warnings: string[] = [];
    let persona: PersonaFireInfo | undefined;
    if (res.matched && user && rule.reply.persona) {
      // A persona reply costs a model call: only with {llm: true} (one dry-run call, nothing sent, turn "dry-run").
      if (input.llm === true) {
        const d = await this.decide(rule, { project, trigger, user, captures: res.captures }, { fireId: null, dryRun: true, message: stored });
        ({ plan, warnings } = d);
        persona = d.persona;
        if (d.skip) notes.push(d.skip);
        if (d.fail) notes.push(`The persona failed: ${d.fail}`);
      } else notes.push('This rule replies with an AI persona: send {"llm": true} to run one dry-run model call (nothing is sent)');
    } else if (res.matched && user) ({ plan, warnings } = decideReply(rule, { project, trigger, user, captures: res.captures }));
    return { ...(persona ? { persona } : {}), matched: res.matched, reasons: res.reasons, notes, captures: res.captures, plan, warnings, message: { id: trigger.id, channel: trigger.channel, to: trigger.to, from: trigger.from, subject: trigger.subject, user: user?.name ?? null } };
  }

  // ------------------------------------------------------------------ views

  /** Unknown {{variables}} in a rule's templates (checked when listed; they render empty). */
  templateWarnings(rule: AutoReplyRule): string[] {
    const out: string[] = [];
    if (rule.reply.persona) return out;
    for (const k of ['text', 'subject', 'html', 'button'] as const) for (const v of variablesOf(rule.reply[k])) if (!knownVariable(v)) out.push(`reply.${k}: {{${v}}} is not a known variable`);
    const caps = [...variablesOf(rule.reply.text), ...variablesOf(rule.reply.subject), ...variablesOf(rule.reply.html)].filter((v) => /^(body\.|subject\.|\$)/.test(v));
    for (const c of caps) {
      const field = c.startsWith('subject.') ? 'subject' : 'body';
      if (!rule.match[field]?.regex) out.push(`{{${c}}} needs a regex on match.${field}`);
    }
    return out;
  }

  viewRule(r: AutoReplyRule): J {
    const run = r.runId ? this.hub.runs.repo.get(r.runId) : null;
    const last = this.repo.lastFire(r.id);
    return {
      ...r,
      run: run?.key ?? null,
      runStatus: run?.status ?? null,
      // A user given by id (persona assignments store the id) is shown by name.
      summary: matchSummary(r.match.user ? { ...r, match: { ...r.match, user: this.hub.users.get(r.projectId, r.match.user)?.name ?? r.match.user } } : r),
      usedUp: r.maxUses !== null && r.uses >= r.maxUses,
      persona: r.reply.persona ? ((p) => (p ? { id: p.id, slug: p.slug, name: p.name } : { id: r.reply.persona, slug: null, name: '(deleted persona)' }))(this.hub.personas?.repo.byId(r.reply.persona)) : null,
      pendingFires: this.repo.countPending(r.id),
      lastFire: last ? { id: last.id, status: last.status, createdAt: last.createdAt, firedAt: last.firedAt, error: last.error } : null,
      warnings: [...(loopWarning(r.disabledReason) ? [loopWarning(r.disabledReason)!] : []), ...this.templateWarnings(r)],
    };
  }

  viewFire(f: AutoReplyFire): J {
    const rule = this.repo.ruleById(f.ruleId);
    const user = f.testUserId ? this.hub.users.get(f.projectId, f.testUserId) : null;
    const trig = this.hub.messages.get(f.triggerMessageId);
    const rep = f.replyMessageId ? this.hub.messages.get(f.replyMessageId) : null;
    const run = f.runId ? this.hub.runs.repo.get(f.runId) : null;
    const brief = (m: Message | null) => (m ? { id: m.id, channel: m.channel, subject: m.subject, text: (m.bodyText ?? '').slice(0, 200), status: m.status, createdAt: m.createdAt } : null);
    return {
      ...f,
      ruleName: rule?.name ?? null,
      user: user ? { id: user.id, name: user.name } : null,
      run: run?.key ?? null,
      trigger: brief(trig ?? null),
      reply: brief(rep ?? null),
    };
  }

  // ------------------------------------------------------------------ lifecycle hooks

  onRunStopped(runId: string): void {
    const pending = this.repo.pendingForRun(runId);
    if (!pending.length) return;
    this.cancelPending(pending, 'The test run was stopped');
    this.changed(pending[0].projectId, { runStopped: runId });
  }

  purgeRun(runId: string): void {
    this.repo.deleteFiresForRun(runId);
  }

  /** Project reset: pending fires are cancelled, fires deleted, uses back to 0 and loop-disabled rules enabled again. Rules stay. */
  resetProject(projectId: string): void {
    this.cancelPending(this.repo.pendingFires(projectId), 'Project reset');
    this.repo.deleteFires(projectId);
    this.repo.resetUses(projectId);
    this.changed(projectId, { reset: true });
  }

  /** Retention: finished fires older than the cutoff (the integrator wires it into maintenance/retention.ts). */
  purgeOlderThan(projectId: string, cutoffIso: string): number {
    return this.repo.deleteFiresBefore(projectId, cutoffIso);
  }
}

export { FIRE_STATUSES, TEMPLATE_VARIABLES };
export type { FireStatus };

/** Presets for GET /api/auto-reply-presets (the dashboard's "Start from"). */
export const AUTO_REPLY_PRESETS = [
  { id: 'reply-code', name: 'Reply with the code', description: 'When a message with a code arrives, the user sends the code back.', rule: { name: 'Reply with the code', channel: 'any', match: { hasOtp: true }, reply: { text: '{{otp}}' } } },
  { id: 'reply-stop', name: 'Reply STOP', description: 'The user opts out of every SMS.', rule: { name: 'Reply STOP', channel: 'sms', match: {}, reply: { text: 'STOP' }, maxUses: 1 } },
  { id: 'confirm-yes', name: 'Confirm YES', description: 'The user answers YES to "reply YES to confirm" messages.', rule: { name: 'Confirm YES', channel: 'any', match: { body: { regex: '/reply\\s+yes/i' } }, reply: { text: 'YES' } } },
  { id: 'out-of-office', name: 'Out of office', description: 'An automatic email reply in the thread.', rule: { name: 'Out of office', channel: 'email', match: {}, reply: { text: 'Hi, I am out of the office until Monday and will reply when I am back.\n\n{{user.name}}', subject: 'Automatic reply: {{subject}}' }, maxUses: 1 } },
  { id: 'tap-first-button', name: 'Tap first button', description: 'WhatsApp: tap the first button of the interactive message ("#2" = the second; or a button id / title).', rule: { name: 'Tap a button', channel: 'whatsapp', match: {}, reply: { text: '', button: '#1' } } },
];
