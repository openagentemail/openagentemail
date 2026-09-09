/**
 * Independent external monitor state machine.
 * Probe the receiver from another host; two failures raise an alarm,
 * recovery is announced, and alerts are cooled down.
 * Recovery during cooldown is kept pending and emitted on a later tick.
 */

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
  return state.lastAlertAtMs != null && nowMs - state.lastAlertAtMs < cooldownMs;
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
    state.lastAlertAtMs = options.nowMs;
    if (!sent.ok) {
      state.alertFailures += 1;
      state.pendingRecovery = true;
      return state;
    }
    state.recoveries += 1;
    state.alarming = false;
    state.pendingRecovery = false;
    state.consecutiveFailures = 0;
    return state;
  }

  state.consecutiveFailures = 0;
  return state;
}

export async function httpProbe(url: string, timeoutMs: number): Promise<{ ok: boolean }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
