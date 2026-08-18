import { describe, expect, mock, test } from 'bun:test';
import {
  isRetryableMailserverConnectionError,
  withMailserverReconnect,
} from '../src/lib/mailserver-reconnect.ts';

describe('mailserver DNS-refresh reconnect', () => {
  test('old container IP refusal re-resolves once and preserves hostname for TLS SNI', async () => {
    const resolve = mock(async () => '172.18.0.5');
    const attempts: { host: string; servername?: string }[] = [];
    const result = await withMailserverReconnect(
      'mailserver',
      async (endpoint) => {
        attempts.push(endpoint);
        if (attempts.length === 1) {
          // Nodemailer wraps the socket code as ESOCKET but keeps ECONNREFUSED in its message.
          throw Object.assign(new Error('connect ECONNREFUSED 172.18.0.3:587'), { code: 'ESOCKET' });
        }
        return 'connected';
      },
      { resolve },
    );

    expect(result).toBe('connected');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([
      { host: 'mailserver' },
      { host: '172.18.0.5', servername: 'mailserver' },
    ]);
  });

  test('Bun Nodemailer ESOCKET CONN failure re-resolves once and retries', async () => {
    const resolve = mock(async () => '172.18.0.5');
    const attempts: { host: string; servername?: string }[] = [];
    const bunConnectError = Object.assign(new Error('Failed to connect'), {
      code: 'ESOCKET',
      command: 'CONN',
      syscall: 'connect',
    });

    expect(isRetryableMailserverConnectionError(bunConnectError)).toBe(true);
    const result = await withMailserverReconnect(
      'mailserver',
      async (endpoint) => {
        attempts.push(endpoint);
        if (attempts.length === 1) throw bunConnectError;
        return 'connected';
      },
      { resolve },
    );

    expect(result).toBe('connected');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([
      { host: 'mailserver' },
      { host: '172.18.0.5', servername: 'mailserver' },
    ]);
  });

  test('auth failures do not resolve or retry', async () => {
    const resolve = mock(async () => '172.18.0.5');
    const connect = mock(async () => {
      throw Object.assign(new Error('authentication failed'), { code: 'EAUTH' });
    });

    await expect(withMailserverReconnect('mailserver', connect, { resolve })).rejects.toMatchObject({
      code: 'EAUTH',
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a second network failure escapes without a third attempt', async () => {
    const resolve = mock(async () => '172.18.0.5');
    const connect = mock(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });

    await expect(withMailserverReconnect('mailserver', connect, { resolve })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('the network-error whitelist includes the required connection failures', () => {
    for (const code of ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
      expect(isRetryableMailserverConnectionError(Object.assign(new Error(code), { code }))).toBe(true);
      expect(isRetryableMailserverConnectionError(Object.assign(new Error('outer'), {
        cause: Object.assign(new Error(code), { code }),
      }))).toBe(true);
      expect(isRetryableMailserverConnectionError(new AggregateError([
        Object.assign(new Error(code), { code }),
      ], 'Happy Eyeballs failed'))).toBe(true);
    }
  });

  test('SMTP transaction text cannot trigger a reconnect without a connection error code', async () => {
    const resolve = mock(async () => '172.18.0.5');
    const transactionError = Object.assign(
      new Error('SMTP DATA failed after remote text mentioned ECONNREFUSED'),
      { code: 'EPIPE' },
    );
    const connect = mock(async () => { throw transactionError; });

    await expect(withMailserverReconnect('mailserver', connect, { resolve })).rejects.toBe(transactionError);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('ESOCKET retries only when its message identifies a connect-stage network failure', () => {
    expect(isRetryableMailserverConnectionError(Object.assign(
      new Error('connect ECONNREFUSED 172.18.0.3:587'),
      { code: 'ESOCKET' },
    ))).toBe(true);
    expect(isRetryableMailserverConnectionError(Object.assign(
      new Error('SMTP DATA contained ECONNREFUSED'),
      { code: 'ESOCKET' },
    ))).toBe(false);
    expect(isRetryableMailserverConnectionError(Object.assign(
      new Error('Failed to send data'),
      { code: 'ESOCKET', command: 'DATA', syscall: 'write' },
    ))).toBe(false);
    expect(isRetryableMailserverConnectionError(Object.assign(
      new Error('SMTP DATA contained connect ECONNREFUSED'),
      { code: 'ESOCKET', command: 'DATA', syscall: 'write' },
    ))).toBe(false);
  });
});
