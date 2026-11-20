import { EventEmitter } from 'node:events';

export type HubEventType =
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'project.reset'
  | 'user.changed'
  | 'provider.changed'
  | 'authenticator.changed'
  | 'rules.changed'
  | 'mocks.changed'
  | 'webhooks.changed'
  | 'message.created'
  | 'message.updated'
  | 'log.created'
  | 'log.updated'
  | 'runs.changed'
  | 'auth.changed'
  | 'verification.updated'
  | 'storage.changed'
  | 'mcptester.changed'
  | 'schedules.changed'
  | 'chat.changed'
  | 'payments.changed';

export interface HubEvent {
  type: HubEventType;
  projectId: string | null;
  data: unknown;
}

/** In-process event bus. SSE clients subscribe; services publish. */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: HubEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(fn: (event: HubEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
