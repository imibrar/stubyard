import type { Config } from './config.js';
import type { DB } from './db/index.js';
import type { EventBus } from './events.js';
import type { Mailpit } from './mailpit/mailpit.js';
import type { Scheduler } from './jobs/scheduler.js';
import type { MessageService } from './messages/service.js';
import type { MessagingSimulator } from './messages/simulator.js';
import type { RuleRepo } from './repos/rules.js';
import type { RuleEngine } from './rules/engine.js';
import type { AuthenticatorRepo } from './repos/authenticators.js';
import type { LogRepo } from './repos/logs.js';
import type { MessageRepo } from './repos/messages.js';
import type { ProjectRepo } from './repos/projects.js';
import type { ProviderRepo } from './repos/providers.js';
import type { UserRepo } from './repos/users.js';
import type { MockRepo } from './repos/mocks.js';
import type { Maintenance } from './maintenance/retention.js';
import type { WebhookRepo } from './repos/webhooks.js';
import type { WebhookService } from './webhooks/service.js';
import type { TlsMaterial } from './tls/ca.js';
import type { TrafficLogger } from './traffic/logger.js';
import type { RunService } from './runs/service.js';
import type { AuthService } from './auth/service.js';
import type { StorageService } from './storage/service.js';
import type { MediaRepo, VerifyRepo } from './repos/verify.js';
import type { McpTesterService } from './mcptester/service.js';
import type { Clock } from './clock/clock.js';
import type { ScheduleService } from './schedules/service.js';
import type { ChatService } from './chat/service.js';
import type { PaymentService } from './payments/service.js';
import type { LlmMockService } from './llmmocks/service.js';
import type { AutoReplyService } from './autoreplies/service.js';
import type { PersonaService } from './personas/service.js';
import type { PushService } from './push/service.js';
import type { StoryboardService, WalkthroughService } from './storyboards/types.js';
import type { RecordingService } from './storyboards/recordings.js';
import type { FeatureService } from './features/service.js';
import type { AccessService } from './access/service.js';

/** Everything route handlers and services need, wired once at startup. */
export interface Hub {
  config: Config;
  db: DB;
  bus: EventBus;
  projects: ProjectRepo;
  users: UserRepo;
  providers: ProviderRepo;
  authenticators: AuthenticatorRepo;
  messages: MessageRepo;
  logs: LogRepo;
  traffic: TrafficLogger;
  messageService: MessageService;
  rules: RuleRepo;
  engine: RuleEngine;
  scheduler: Scheduler;
  simulator: MessagingSimulator;
  /** API mocks (/mock/<project>/api/…). */
  mocks: MockRepo;
  /** Retention, size limit, auto-reset. */
  maintenance: Maintenance;
  /** Webhook endpoints, templates and sequences (Phase 3). */
  webhooks: WebhookRepo;
  webhookService: WebhookService;
  /** Test runs: isolation of parallel test workers. */
  runs: RunService;
  /** Login providers: fake OAuth 2.0 / OpenID Connect identity providers (/auth/<project>/<provider>/…). */
  auth: AuthService;
  /** File storage simulator (S3 family, …) under /storage/<project>/<instance>/…. */
  storage: StorageService;
  /** Verify APIs (Twilio Verify, Vonage Verify v2): services and verifications. */
  verify: VerifyRepo;
  /** Uploaded WhatsApp media. */
  media: MediaRepo;
  /** MCP tester: stubyard as an MCP client of the developer's MCP servers (saved targets, sessions, checks). */
  mcpTester: McpTesterService;
  /** stubyard's clock with per-feature offsets (totp, auth, verify, webhooks) per project / run. */
  clock: Clock;
  /** Scheduled actions: allowlisted API calls made later / repeated (schedules table, "schedule.fire" jobs). */
  schedules: ScheduleService;
  /** AI chat v1: AI providers (global), chat agents, conversations, saved prompts. */
  chat: ChatService;
  /** Payments 1a: fake Stripe Checkout / PayTabs / PayPal gateways, hosted pages, outcome rules, webhooks. */
  payments: PaymentService;
  /** LLM API mocks: fake OpenAI / Anthropic APIs under /llm/<project>/…, fault rules, record-to-mock, call log. */
  llm: LlmMockService;
  /** Scripted auto-replies: test users answer the app's emails / SMS / WhatsApp by themselves (rules, fires). */
  autoReplies: AutoReplyService;
  /** AI personas: test users whose replies an LLM writes in character (rides on auto-replies, §AE). */
  personas: PersonaService;
  /** Push notifications: fake FCM HTTP v1 (/push/<project>/<instance>/…) and APNs (HTTP/2 listener), devices, inbox, faults. */
  push: PushService;
  /** Storyboards: login recipes, data sets, storyboards, page snapshots, bundles (docs/design/storyboards.md). */
  storyboards?: StoryboardService;
  /** Walkthroughs: one human run through a storyboard (steps, screenshots, sign-off). */
  walkthroughs?: WalkthroughService;
  /** Walkthrough recordings (DOM recording segments uploaded by the extension; storyboards/recordings.ts). */
  recordings?: RecordingService;
  /** Features board: features, tasks / subtasks and images per project (features/service.ts). */
  features?: FeatureService;
  mailpit: Mailpit | null;
  tls: TlsMaterial | null;
  /** Sign-in: Open mode (no accounts) or Single admin; sessions and API tokens (access/service.ts). */
  access: AccessService;
}
