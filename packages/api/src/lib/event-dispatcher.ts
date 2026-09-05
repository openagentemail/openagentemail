/**
 * Process-wide event dispatcher with per-sink watermark isolation (§11.4).
 *
 * Sits across two producers:
 * 1. Inbound mail loop (IMAP watcher): emits mail.received with per-sink watermark isolation.
 * 2. Task path (createApprovalTask): emits approval.requested with non-blocking hand-off.
 */

import type { FetchMessageObject } from 'imapflow';
import type { Identity } from './identities.ts';
import type { NotifyService } from './notify.ts';
import { isNotifyServiceFailure, notificationService } from './notify.ts';
import type { ApprovalTask } from './tasks-internal.ts';

export type WatchedMessage = Pick<
  FetchMessageObject,
  'envelope' | 'headers' | 'source' | 'flags' | 'internalDate' | 'uid'
>;

export type MailReceivedEvent = {
  type: 'mail.received';
  message: WatchedMessage;
  uidValidity?: bigint;
};

export type ApprovalRequestedEvent = {
  type: 'approval.requested';
  task: ApprovalTask;
};

export type ProcessEvent = MailReceivedEvent | ApprovalRequestedEvent;

/** Per-sink watermark for inbound mail progression (in-memory, survives IMAP reconnects). */
export type SinkWatermark = {
  uid?: number;
  uidValidity?: bigint;
  serviceFailure?: { uid: number; sinceMs: number };
  consecutivePublishSkips?: number;
};

export type MailDispatchContext = {
  clickUrl?: string;
  refreshIdentity?: (address: string) => Identity | undefined;
  wait?: (ms: number) => Promise<void>;
  error?: typeof console.error;
  identities?: Identity[];
};

export interface EventSink {
  readonly id: string;
  isEnabled(): boolean;
  watermark?: SinkWatermark;
  handleMail?(event: MailReceivedEvent, context?: MailDispatchContext): Promise<void>;
  handleApproval?(event: ApprovalRequestedEvent): Promise<void>;
}

export function isSinkServiceFailure(err: unknown): boolean {
  if (err && typeof err === 'object' && 'failureKind' in err) {
    return (err as any).failureKind === 'service';
  }
  return isNotifyServiceFailure(err);
}

export class EventDispatcher {
  readonly kind = 'event-dispatcher' as const;
  private sinks: Map<string, EventSink> = new Map();
  private errorLogger: typeof console.error;

  constructor(options?: { error?: typeof console.error; sinks?: EventSink[] }) {
    this.errorLogger = options?.error ?? console.error;
    if (options?.sinks) {
      for (const sink of options.sinks) {
        this.registerSink(sink);
      }
    }
  }

  registerSink(sink: EventSink): void {
    this.sinks.set(sink.id, sink);
  }

  unregisterSink(id: string): boolean {
    return this.sinks.delete(id);
  }

  getSink(id: string): EventSink | undefined {
    return this.sinks.get(id);
  }

  getAllSinks(): EventSink[] {
    return Array.from(this.sinks.values());
  }

  getMailSinks(): EventSink[] {
    return Array.from(this.sinks.values()).filter((s) => typeof s.handleMail === 'function');
  }

  getApprovalSinks(): EventSink[] {
    return Array.from(this.sinks.values()).filter((s) => typeof s.handleApproval === 'function');
  }

  /**
   * Producer 2: task-creation path (createApprovalTask).
   * Hand-off, never await (§11.4 item 4).
   * Enqueue and return immediately so the task creation 201 response is never blocked.
   */
  dispatchApprovalRequested(task: ApprovalTask): void {
    let candidateSinks: EventSink[];
    try {
      candidateSinks = this.getApprovalSinks();
    } catch (err) {
      this.errorLogger(
        '[dispatcher] Failed retrieving approval sinks:',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (candidateSinks.length === 0) return;

    const event: ApprovalRequestedEvent = {
      type: 'approval.requested',
      task,
    };
    queueMicrotask(() => {
      for (const sink of candidateSinks) {
        let enabled = false;
        try {
          enabled = sink.isEnabled();
        } catch (err) {
          this.errorLogger(
            `[dispatcher] Sink ${sink.id} threw checking isEnabled:`,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }
        if (!enabled) continue;

        try {
          sink.handleApproval?.(event).catch((err) => {
            this.errorLogger(
              `[dispatcher] Sink ${sink.id} failed handling approval.requested:`,
              err instanceof Error ? err.message : String(err),
            );
          });
        } catch (err) {
          this.errorLogger(
            `[dispatcher] Sink ${sink.id} threw synchronously handling approval.requested:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    });
  }

  /** Backward compatibility for any caller expecting { publish: ... } */
  publish: NotifyService['publish'] = async (input) => {
    return notificationService().publish(input);
  };
}

export function isEventDispatcher(value: unknown): value is EventDispatcher {
  return (
    !!value &&
    typeof value === 'object' &&
    ((value as any).kind === 'event-dispatcher' || typeof (value as any).getMailSinks === 'function')
  );
}

let processDispatcher: EventDispatcher | null = null;

export function getEventDispatcher(): EventDispatcher {
  if (!processDispatcher) {
    processDispatcher = new EventDispatcher();
  }
  return processDispatcher;
}

export function setEventDispatcherForTests(dispatcher: EventDispatcher | null): void {
  processDispatcher = dispatcher;
}
