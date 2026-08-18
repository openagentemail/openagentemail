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
};

const RETRYABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : '';
  return `${code} ${error.message} ${error.cause instanceof Error ? errorText(error.cause) : ''}`;
}

export function isRetryableMailserverConnectionError(error: unknown): boolean {
  return [...RETRYABLE_NETWORK_CODES].some((code) => errorText(error).includes(code));
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
 */
export async function withMailserverReconnect<T>(
  hostname: string,
  connect: (endpoint: MailserverEndpoint) => Promise<T>,
  { resolve = resolveFreshMailserverHost, beforeRetry }: RetryOptions = {},
): Promise<T> {
  try {
    return await connect({ host: hostname });
  } catch (error) {
    if (!isRetryableMailserverConnectionError(error)) throw error;
    await beforeRetry?.(error);
    const address = await resolve(hostname);
    return connect({ host: address, servername: hostname });
  }
}
