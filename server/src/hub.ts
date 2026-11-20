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
  /** MCP tester: devhub as an MCP client of the developer's MCP servers (saved targets, sessions, checks). */
  mcpTester: McpTesterService;
  mailpit: Mailpit | null;
  tls: TlsMaterial | null;
}
