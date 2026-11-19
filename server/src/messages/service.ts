import type { EventBus } from '../events.js';
import type { Channel } from '../providers/catalog.js';
import type { MessageRepo, Message, NewMessage } from '../repos/messages.js';
import type { Project } from '../repos/projects.js';
import type { ProviderInstance } from '../repos/providers.js';
import type { TestUser, UserRepo } from '../repos/users.js';
import type { RunResolver } from '../runs/resolver.js';
import { normalizeEmail, normalizePhone } from '../util.js';
import { extractLinks, extractOtp } from './extract.js';
import { smsSegments } from './sms-segments.js';
import { lintMessage, type LintFinding, type LintInput } from '../lint/checks.js';

export interface CaptureInput {
  project: Project;
  instance: ProviderInstance | null;
  channel: Channel;
  direction?: 'outbound' | 'inbound';
  from: string | null;
  to: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  attachments?: number;
  mailpitId?: string | null;
  messageIdHeader?: string | null;
  status: string;
  statusDetail?: string | null;
  appliedRule?: unknown;
  logId: string | null;
  metadata?: Record<string, unknown>;
  providerMessageId?: string | null;
  /** Force the test user (inbound replies belong to the user who "sent" them). */
  testUserId?: string | null;
  duplicateWindowSeconds?: number;
  /** Test run (null = none). Omitted: derived from the user / recipient / the project's default run. */
  runId?: string | null;
  /** Known code (Verify APIs generate it): skips OTP extraction. */
  otp?: string | null;
  /** Extra inputs for the content checks: email headers, text part present, From display name, subject as sent. */
  lintInput?: Pick<LintInput, 'headers' | 'hasTextPart' | 'fromName' | 'subject'>;
}

/** Turns captured traffic into inbox messages: matches the test user and extracts OTP/links. */
export class MessageService {
  /** Set at startup; without it messages are never attributed to a run. */
  runs: RunResolver | null = null;

  constructor(
    private messages: MessageRepo,
    private users: UserRepo,
    private bus: EventBus,
  ) {}

  matchUser(projectId: string, channel: Channel, address: string): TestUser | null {
    if (channel === 'email') {
      const e = normalizeEmail(address);
      return e ? this.users.findByEmail(projectId, e) : null;
    }
    const p = normalizePhone(address);
    return p ? this.users.findByPhone(projectId, p, channel) : null;
  }

  capture(input: CaptureInput): Message {
    const to = input.channel === 'email' ? normalizeEmail(input.to) ?? input.to : normalizePhone(input.to) ?? input.to;
    const user =
      input.testUserId !== undefined
        ? input.testUserId
          ? { id: input.testUserId }
          : null
        : input.direction === 'inbound'
          ? null
          : this.matchUser(input.project.id, input.channel, to);
    const text = input.text ?? null;
    const m: NewMessage = {
      projectId: input.project.id,
      testUserId: user?.id ?? null,
      providerInstanceId: input.instance?.id ?? null,
      channel: input.channel,
      direction: input.direction ?? 'outbound',
      from: input.from,
      to,
      subject: input.subject ?? null,
      bodyText: text,
      hasHtml: !!input.html,
      attachments: input.attachments ?? 0,
      mailpitId: input.mailpitId ?? null,
      messageIdHeader: input.messageIdHeader ?? null,
      status: input.status,
      statusDetail: input.statusDetail ?? null,
      appliedRule: input.appliedRule,
      otp: input.otp !== undefined ? input.otp : extractOtp([input.subject, text].filter(Boolean).join('\n'), input.project.settings.otpRegex),
      links: extractLinks(text, input.html),
      logId: input.logId,
      providerMessageId: input.providerMessageId ?? null,
      // SMS: how the carrier would encode and split it (GSM-7 160/153, UCS-2 70/67), for the UI and assertions.
      metadata: input.channel === 'sms' ? { ...input.metadata, ...smsMeta(text) } : input.metadata,
      lint: input.direction === 'inbound' ? [] : lintCapture(input),
      runId:
        input.runId !== undefined
          ? input.runId
          : (this.runs?.captureRun(input.project.id, input.channel, to, user?.id ?? null, input.direction ?? 'outbound') ?? null),
    };
    // Same content to the same user through a different instance shortly before: likely a double send.
    if (m.direction === 'outbound' && input.duplicateWindowSeconds !== 0) {
      const since = new Date(Date.now() - (input.duplicateWindowSeconds ?? 60) * 1000).toISOString();
      const dup = this.messages.findDuplicate(m, since);
      if (dup) {
        m.duplicateOfId = dup.id;
        m.metadata = { ...(m.metadata ?? {}), duplicateWarning: `Same message sent ${Math.round((Date.now() - Date.parse(dup.createdAt)) / 1000)}s earlier via another provider instance` };
      }
    }
    const saved = this.messages.insert(m);
    this.bus.publish({ type: 'message.created', projectId: input.project.id, data: saved });
    return saved;
  }
}

function smsMeta(text: string | null): { segments: number; encoding: string; characters: number } {
  const s = smsSegments(text ?? '');
  return { segments: s.segments, encoding: s.encoding, characters: s.characters };
}

/** Content checks for an outbound message. Never throws: a lint bug must not lose a captured message. */
function lintCapture(input: CaptureInput): LintFinding[] {
  try {
    const settings = input.project.settings;
    const tpl = (input.metadata?.wa as { template?: { name?: string; params?: (string | null)[] } } | undefined)?.template;
    return lintMessage({
      channel: input.channel,
      subject: input.subject ?? null,
      text: input.text ?? null,
      html: input.html ?? null,
      ...input.lintInput,
      instanceLabels: input.instance?.labels ?? [],
      waTemplate: tpl && Array.isArray(tpl.params) ? { name: String(tpl.name ?? ''), params: tpl.params } : null,
      disabled: Array.isArray(settings.lintDisabled) ? settings.lintDisabled : [],
      productionDomains: Array.isArray(settings.productionDomains) ? settings.productionDomains : [],
    });
  } catch (err) {
    return [{ check: 'internal', severity: 'info', message: `Content checks failed: ${(err as Error).message}` }];
  }
}
