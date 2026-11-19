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
  | 'message.created'
  | 'message.updated'
  | 'log.created'
  | 'log.updated';

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
