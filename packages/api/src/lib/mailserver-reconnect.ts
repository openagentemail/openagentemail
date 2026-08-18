import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface MailserverEndpoint {
  /** The address used for this one connection attempt. */
  host: string;
  /** Original hostname retained for TLS SNI when host is a freshly resolved IP. */
  servername?: string;
}

type RetryOptions = {
  resolve?: (hostname: string) => Promise<string>;
  beforeRetry?: (error: unknown) => void | Promise<void>;
  /** Runs after fresh DNS resolves and immediately before the retry creates a resource. */
  beforeRetryConnect?: () => void;
};

const RETRYABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function collectErrorCodes(error: unknown, seen = new Set<unknown>(), codes = new Set<string>()): Set<string> {
  if (!error || typeof error !== 'object' || seen.has(error)) return codes;
  seen.add(error);
  const code = errorCode(error);
  if (code) codes.add(code);
  const cause = (error as Error & { cause?: unknown }).cause;
  collectErrorCodes(cause, seen, codes);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) collectErrorCodes(nested, seen, codes);
  }
  return codes;
}

function isEsocketConnectFailure(error: unknown): boolean {
  if (errorCode(error) !== 'ESOCKET' || !(error instanceof Error)) return false;
  const messages = [error.message];
  let cause = error.cause;
  const seen = new Set<unknown>();
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    messages.push(cause.message);
    cause = cause.cause;
  }
  return messages.some((message) => /\bconnect\s+(?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/.test(message));
}

export function isRetryableMailserverConnectionError(error: unknown): boolean {
  return [...collectErrorCodes(error)].some((code) => RETRYABLE_NETWORK_CODES.has(code)) ||
    isEsocketConnectFailure(error);
}

/**
 * Queries DNS directly instead of using the runtime's hostname-connect cache.
 * This address is deliberately used for one retry only; callers retain `servername`
 * so TLS continues to validate the configured hostname rather than the container IP.
 */
export async function resolveFreshMailserverHost(hostname: string): Promise<string> {
  if (isIP(hostname)) return hostname;
  try {
    const addresses = await resolve4(hostname);
    if (addresses[0]) return addresses[0];
  } catch {
    // Docker's embedded DNS normally has an A record; try IPv6 before surfacing DNS failure.
  }
  const addresses = await resolve6(hostname);
  if (!addresses[0]) throw new Error(`DNS returned no addresses for ${hostname}`);
  return addresses[0];
}

/**
 * First attempt deliberately uses the configured hostname. Only a stale-network
 * failure gets one fresh-resolution retry; no resolved address is retained after it.
 * This wrapper does not own teardown: a `connect` callback must close resources it
 * creates before rethrowing, because retries replace those resources.
 */
export async function withMailserverReconnect<T>(
  hostname: string,
  connect: (endpoint: MailserverEndpoint) => Promise<T>,
  { resolve = resolveFreshMailserverHost, beforeRetry, beforeRetryConnect }: RetryOptions = {},
): Promise<T> {
  try {
    return await connect({ host: hostname });
  } catch (error) {
    if (!isRetryableMailserverConnectionError(error)) throw error;
    await beforeRetry?.(error);
    const address = await resolve(hostname);
    beforeRetryConnect?.();
    return connect({ host: address, servername: hostname });
  }
}
