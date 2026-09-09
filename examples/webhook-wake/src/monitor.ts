/**
 * Independent external monitor state machine.
 * Probe the receiver from another host; two failures raise an alarm,
 * recovery is announced, and alerts are cooled down.
 * Recovery during cooldown is kept pending and emitted on a later tick.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AlertEvent } from './types.ts';

export type MonitorConfig = {
  intervalMs: number;
  failThreshold: number;
  cooldownMs: number;
};

export type ProbeFn = () => Promise<{ ok: boolean }>;
export type AlertSink = (event: AlertEvent) => Promise<{ ok: boolean; reason?: string }>;

export type MonitorState = {
  consecutiveFailures: number;
  alarming: boolean;
  pendingRecovery: boolean;
  lastAlertAtMs: number | null;
  probes: number;
  alarms: number;
  recoveries: number;
  alertFailures: number;
};

export const DEFAULT_MONITOR: MonitorConfig = {
  intervalMs: 30_000,
  failThreshold: 2,
  cooldownMs: 5 * 60_000,
};

export function createMonitorState(): MonitorState {
  return {
    consecutiveFailures: 0,
    alarming: false,
    pendingRecovery: false,
    lastAlertAtMs: null,
    probes: 0,
    alarms: 0,
    recoveries: 0,
    alertFailures: 0,
  };
}

function inCooldown(state: MonitorState, nowMs: number, cooldownMs: number): boolean {
  if (state.lastAlertAtMs == null) return false;
  if (nowMs < state.lastAlertAtMs) return false;
  return nowMs - state.lastAlertAtMs < cooldownMs;
}

export async function stepMonitor(options: {
  state: MonitorState;
  probe: ProbeFn;
  alert: AlertSink;
  nowMs: number;
  config?: Partial<MonitorConfig>;
}): Promise<MonitorState> {
  const cfg = { ...DEFAULT_MONITOR, ...options.config };
  const state = options.state;
  state.probes += 1;
  const result = await options.probe();

  if (!result.ok) {
    state.pendingRecovery = false;
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= cfg.failThreshold && !inCooldown(state, options.nowMs, cfg.cooldownMs)) {
      const sent = await options.alert({ kind: 'monitor_failure', code: 'health_failed' });
      // Intentional: stamp on the attempt so a down sink is not retried every
      // interval. monitor.sh stamps last_alert only after a successful
      // health_failed; this helper is not claimed as parity on that branch.
      state.lastAlertAtMs = options.nowMs;
      if (sent.ok) {
        state.alarming = true;
        state.alarms += 1;
      } else {
        state.alertFailures += 1;
        const retry = await options.alert({ kind: 'monitor_failure', code: 'monitor_alert_failed' });
        if (!retry.ok) {
          state.alertFailures += 1;
        }
      }
    }
    return state;
  }

  if (state.alarming || state.pendingRecovery) {
    if (inCooldown(state, options.nowMs, cfg.cooldownMs)) {
      state.pendingRecovery = true;
      state.consecutiveFailures = 0;
      return state;
    }
    const sent = await options.alert({ kind: 'monitor_recovery', code: 'health_recovered' });
    if (!sent.ok) {
      // Do not advance lastAlertAtMs: next healthy tick retries without a
      // full cooldown (same as monitor.sh last_alert-on-success only).
      state.alertFailures += 1;
      state.pendingRecovery = true;
      return state;
    }
    state.lastAlertAtMs = options.nowMs;
    state.recoveries += 1;
    state.alarming = false;
    state.pendingRecovery = false;
    state.consecutiveFailures = 0;
    return state;
  }

  state.consecutiveFailures = 0;
  return state;
}

/** Direct GET: exact HTTP 200 only. Never follow redirects. */
export async function httpProbe(url: string, timeoutMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ ok });
    };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      done(false);
      return;
    }
    const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        done(res.statusCode === 200);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}
