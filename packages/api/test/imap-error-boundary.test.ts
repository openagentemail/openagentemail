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

class TeardownErrorClient extends EventEmitter {
  closeCalls = 0;
  logoutCalls = 0;

  constructor(private readonly teardownError: Error) {
    super();
  }

  async connect() {}

  async getMailboxLock() {
    return { release: () => { this.emit('error', this.teardownError); } };
  }

  async logout() {
    this.logoutCalls += 1;
  }

  close() {
    this.closeCalls += 1;
  }
}

class SuccessfulClient extends EventEmitter {
  closeCalls = 0;
  logoutCalls = 0;

  async connect() {}

  async getMailboxLock() {
    return { release() {} };
  }

  async logout() {
    this.logoutCalls += 1;
  }

  close() {
    this.closeCalls += 1;
  }
}

class RetryClient extends EventEmitter {
  closeCalls = 0;
  logoutCalls = 0;

  constructor(private readonly failConnect: boolean) {
    super();
  }

  async connect() {
    if (this.failConnect) {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
  }

  async getMailboxLock() {
    return { release() {} };
  }

  async logout() {
    this.logoutCalls += 1;
  }

  close() {
    this.closeCalls += 1;
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
    expect(client.listenerCount('error')).toBe(1);
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
    expect(client.listenerCount('error')).toBe(1);
    expect(logs).toEqual([['[imap] abortable INBOX connection error; closing current operation']]);
  });

  test('拆卸期连接错误优先于先发生的操作错误，两个封装口径一致', async () => {
    const operationError = new Error('operation failed first');
    const teardownError = new Error('connection failed during teardown');

    const regular = new TeardownErrorClient(teardownError);
    await expect(withInbox(
      async () => { throw operationError; },
      { createClient: () => regular as unknown as ImapFlow, error: () => {} },
    )).rejects.toBe(teardownError);
    expect(regular.closeCalls).toBe(1);

    const abortable = new TeardownErrorClient(teardownError);
    await expect(withInboxAbortable(
      new AbortController().signal,
      async () => { throw operationError; },
      { createClient: () => abortable as unknown as ImapFlow, error: () => {} },
    )).rejects.toBe(teardownError);
    expect(abortable.closeCalls).toBe(1);
  });

  test('封装返回后迟发 error 仍有全生命周期监听，不逃逸且不重复 close', async () => {
    const lateError = new Error('late socket destroy error');

    const regular = new SuccessfulClient();
    await withInbox(async () => undefined, {
      createClient: () => regular as unknown as ImapFlow,
      error: () => {},
    });
    expect(() => regular.emit('error', lateError)).not.toThrow();
    expect(regular.closeCalls).toBe(1);

    const abortable = new SuccessfulClient();
    await withInboxAbortable(new AbortController().signal, async () => undefined, {
      createClient: () => abortable as unknown as ImapFlow,
      error: () => {},
    });
    expect(() => abortable.emit('error', lateError)).not.toThrow();
    expect(abortable.closeCalls).toBe(1);
  });

  test('常驻回归：两个封装都接住并原样重抛同一个 emitted Error', async () => {
    const emitted = new Error('shared emitted error');

    const regular = new OperationErrorClient();
    await expect(withInbox(
      (imap) => (imap as unknown as OperationErrorClient).operation(emitted),
      { createClient: () => regular as unknown as ImapFlow, error: () => {} },
    )).rejects.toBe(emitted);

    const abortable = new ConnectErrorClient(emitted);
    await expect(withInboxAbortable(
      new AbortController().signal,
      async () => undefined,
      { createClient: () => abortable as unknown as ImapFlow, error: () => {} },
    )).rejects.toBe(emitted);
  });

  test('重试前关闭未 emit error 的失败 client，不遗留连接', async () => {
    const first = new RetryClient(true);
    const second = new RetryClient(false);
    let calls = 0;

    await expect(withInbox(async () => 'ok', {
      createClient: () => (calls++ === 0 ? first : second) as unknown as ImapFlow,
      resolveMailserver: async () => '172.18.0.5',
      error: () => {},
    })).resolves.toBe('ok');

    expect(first.closeCalls).toBe(1);
    expect(second.logoutCalls).toBe(1);
  });

  test('abort during fresh DNS resolution never creates a second client', async () => {
    const controller = new AbortController();
    const first = new RetryClient(true);
    let resolveAddress: ((address: string) => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const resolving = new Promise<string>((resolve) => {
      resolveAddress = resolve;
    });
    const resolutionStarted = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let factoryCalls = 0;

    const pending = withInboxAbortable(controller.signal, async () => undefined, {
      createClient: () => {
        factoryCalls += 1;
        return first as unknown as ImapFlow;
      },
      resolveMailserver: async () => {
        startedResolve!();
        return resolving;
      },
      error: () => {},
    });
    await resolutionStarted;
    controller.abort();
    resolveAddress!('172.18.0.5');

    const rejected = await pending.then(
      () => undefined,
      (error) => error,
    );
    expect(factoryCalls).toBe(1);
    expect(first.closeCalls).toBe(1);
    expect(rejected).toMatchObject({ message: 'scan_aborted' });
  });
});
