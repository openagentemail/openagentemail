/** Bounded alert hook. Codes are fixed; caller input is never interpolated. */

import type { AlertEvent, AlertFn } from './types.ts';

const ALLOWED_CODES = new Set([
  'send_failed',
  'storage_failed',
  'storage_capacity',
  'timeout_killed',
  'unknown_mapping',
  'stale_mapping',
  'alert_failed',
  'ready_failed',
  'health_failed',
  'health_recovered',
  'monitor_probe_failed',
  'monitor_alert_failed',
]);

export function sanitizeAlertEvent(event: AlertEvent): AlertEvent {
  const code = ALLOWED_CODES.has(event.code) ? event.code : 'ready_failed';
  return { kind: event.kind, code };
}

export function createHttpAlert(url: string | null, timeoutMs: number): AlertFn {
  return async (event) => {
    if (!url) {
      return { ok: true };
    }
    const body = JSON.stringify(sanitizeAlertEvent(event));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: ac.signal,
      });
      if (!res.ok) {
        return { ok: false, reason: 'alert_http_status' };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: 'alert_transport' };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function recordingAlert(bucket: AlertEvent[]): AlertFn {
  return async (event) => {
    bucket.push(sanitizeAlertEvent(event));
    return { ok: true };
  };
}
