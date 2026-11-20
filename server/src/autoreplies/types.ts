import type { Channel } from '../providers/catalog.js';
import type { PersonaFireInfo } from '../personas/service.js';

/** Channel a rule listens on ("any" = every channel). */
export type AutoReplyChannel = Channel | 'any';
export const AUTO_REPLY_CHANNELS: AutoReplyChannel[] = ['email', 'sms', 'whatsapp', 'any'];

/** A text condition: a bare string in the API means { contains } (case-insensitive). */
export interface TextCondition {
  equals?: string;
  contains?: string;
  /** "/src/flags" or a plain pattern (flag i). */
  regex?: string;
}

export interface AutoReplyMatch {
  to?: TextCondition;
  from?: TextCondition;
  subject?: TextCondition;
  body?: TextCondition;
  /** Test user: id, email, phone or name. */
  user?: string;
  /** Test user role, e.g. "customer". */
  role?: string;
  /** Provider instance slug the app sent through. */
  instance?: string;
  hasOtp?: boolean;
  hasLink?: boolean;
}

export interface AutoReplySpec {
  /** Template ({{otp}}, {{body.1}}, …). Optional for a WhatsApp button reply and for a persona reply. */
  text?: string;
  /** AI persona (id) that writes the reply instead of a template (§AE). Exclusive with text / button / subject / html. */
  persona?: string;
  /** Persona rules: one extra line for the persona, for this rule only. */
  instruction?: string;
  subject?: string;
  html?: string;
  /** Default: the channel of the message that triggered the rule. */
  channel?: Channel;
  /** Provider instance slug to reply through (default: the trigger's instance, else the channel default). */
  instance?: string;
  /** WhatsApp: id or title of a button / list row of the trigger message. */
  button?: string;
  /** Email: reply in the thread (In-Reply-To / References, "Re:" subject). Default true. */
  thread?: boolean;
}

export interface AutoReplyRule {
  id: string;
  projectId: string;
  runId: string | null;
  name: string;
  position: number;
  enabled: boolean;
  channel: AutoReplyChannel;
  match: AutoReplyMatch;
  reply: AutoReplySpec;
  delayMs: number;
  jitterMs: number;
  maxUses: number | null;
  uses: number;
  /** true (default): no later rule is evaluated after this one matched. */
  stop: boolean;
  /** Set when stubyard switched the rule off by itself ("loop"). */
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FireStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'skipped';
export const FIRE_STATUSES: FireStatus[] = ['pending', 'sending', 'sent', 'failed', 'cancelled', 'skipped'];

/** What a rule decided to send (rendered at fire time). Round 4 personas produce the same shape. */
export interface ReplyPlan {
  channel: Channel;
  text: string;
  subject?: string | null;
  html?: string | null;
  instance?: string | null;
  button?: string | null;
  contextMessageId?: string | null;
  inReplyTo?: string | null;
  to?: string | null;
}

/** Stored on the fire: captures at match time, the rendered reply and warnings at fire time. */
export interface FirePlan {
  captures: Record<string, string>;
  rendered?: ReplyPlan;
  warnings: string[];
  /** Persona rules: the persona, thread and turn that wrote the reply. */
  persona?: PersonaFireInfo;
}

export interface AutoReplyFire {
  id: string;
  projectId: string;
  ruleId: string;
  runId: string | null;
  triggerMessageId: string;
  testUserId: string | null;
  jobId: string | null;
  status: FireStatus;
  dueAt: string;
  firedAt: string | null;
  plan: FirePlan;
  replyMessageId: string | null;
  webhookStatus: number | null;
  webhookOk: boolean | null;
  error: string | null;
  createdAt: string;
}
