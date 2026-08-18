process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { EventEmitter } from 'node:events';
import type { ImapFlow } from 'imapflow';

const { describe, expect, test } = await import('bun:test');
const { withInbox, withInboxAbortable } = await import('../src/lib/imap.ts');

class OperationErrorClient extends EventEmitter {
  closeCalls = 0;
  logoutCalls = 0;
  releaseCalls = 0;
  private rejectOperation?: (error: Error) => void;

  async connect() {}

  async getMailboxLock() {
    return { release: () => { this.releaseCalls += 1; } };
  }

  operation(error: Error): Promise<void> {
    return new Promise((_resolve, reject) => {
      this.rejectOperation = reject;
      queueMicrotask(() => this.emit('error', error));
    });
  }

  async logout() {
    this.logoutCalls += 1;
  }

  close() {
    this.closeCalls += 1;
    this.rejectOperation?.(new Error('closed current operation'));
  }
}

class ConnectErrorClient extends EventEmitter {
  closeCalls = 0;
  logoutCalls = 0;
  private rejectConnect?: (error: Error) => void;

  constructor(private readonly emitted: Error) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((_resolve, reject) => {
      this.rejectConnect = reject;
      queueMicrotask(() => this.emit('error', this.emitted));
    });
  }

  async getMailboxLock() {
    return { release() {} };
  }

  async logout() {
    this.logoutCalls += 1;
  }

  close() {
    this.closeCalls += 1;
    this.rejectConnect?.(new Error('closed connect'));
  }
}

describe('IMAP async error boundaries', () => {
  test('withInbox catches an out-of-band error, fails the operation, and closes once', async () => {
    const client = new OperationErrorClient();
    const emitted = new Error('async socket failure during operation');
    const logs: unknown[][] = [];

    await expect(withInbox(
      (imap) => (imap as unknown as OperationErrorClient).operation(emitted),
      {
        createClient: () => client as unknown as ImapFlow,
        error: (...args) => { logs.push(args); },
      },
    )).rejects.toBe(emitted);

    expect(client.closeCalls).toBe(1);
    expect(client.logoutCalls).toBe(0);
    expect(client.releaseCalls).toBe(1);
    expect(client.listenerCount('error')).toBe(0);
    expect(logs).toEqual([['[imap] INBOX connection error; closing current operation']]);
  });

  test('withInboxAbortable catches a connect-phase error and preserves closeOnce', async () => {
    const emitted = new Error('async socket failure during connect');
    const client = new ConnectErrorClient(emitted);
    const controller = new AbortController();
    const logs: unknown[][] = [];

    await expect(withInboxAbortable(
      controller.signal,
      async () => undefined,
      {
        createClient: () => client as unknown as ImapFlow,
        error: (...args) => { logs.push(args); },
      },
    )).rejects.toBe(emitted);

    expect(client.closeCalls).toBe(1);
    expect(client.logoutCalls).toBe(0);
    expect(client.listenerCount('error')).toBe(0);
    expect(logs).toEqual([['[imap] abortable INBOX connection error; closing current operation']]);
  });
});
