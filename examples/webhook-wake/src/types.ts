/** Shared types for the standalone webhook-wake receiver. */

export type ReceiverMode = 'observe' | 'canary';

export type RouteBinding = {
  routeKey: string;
  subscriptionId: string;
  domain: string;
  mailbox: string;
  secret: string;
  previousSecret?: string;
  terminal: string;
  active: boolean;
  stale: boolean;
};

export type DedupConfig = {
  path: string;
  retentionMs: number;
  maxRecords: number;
};

export type AlertHookConfig = {
  url: string | null;
  timeoutMs: number;
};

export type ReceiverConfig = {
  listen: { host: string; port: number };
  mode: ReceiverMode;
  canaryTerminal: string | null;
  orcaBinary: string;
  bodyLimitBytes: number;
  timestampToleranceSec: number;
  maxV1Signatures: number;
  maxHeaderBytes: number;
  requestTimeoutMs: number;
  maxConcurrent: number;
  sendTimeoutMs: number;
  outputCapBytes: number;
  dedup: DedupConfig;
  alertHook: AlertHookConfig;
  routes: RouteBinding[];
};

export type VerifyReason =
  | 'missing_header'
  | 'invalid_header'
  | 'timestamp_out_of_range'
  | 'signature_mismatch';

export type VerifyResult =
  | { valid: true; timestampSec: number }
  | { valid: false; reason: VerifyReason };

export type Disposition =
  | 'submitted'
  | 'would_wake'
  | 'duplicate'
  | 'ping_ok'
  | 'ignored'
  | 'rejected'
  | 'send_failed'
  | 'storage_failed'
  | 'unauthorized'
  | 'invalid'
  | 'busy';

export type HandleResult = {
  status: number;
  disposition: Disposition;
  reason?: string;
  submitted?: boolean;
  sends?: number;
};

export type DedupRecord = {
  key: string;
  status: 'success' | 'observed';
  storedAtMs: number;
  expiresAtMs: number;
};

export type Metrics = {
  received: number;
  verified: number;
  ping: number;
  wouldWake: number;
  submitted: number;
  duplicates: number;
  ignored: number;
  rejected: number;
  sendFailed: number;
  storageFailed: number;
  alertFailed: number;
  unauthorized: number;
  timeoutKill: number;
};

export type WakeRequest = {
  terminal: string;
  text: string;
  argv: string[];
};

export type WakeResult = {
  ok: boolean;
  reason?: 'timeout_killed' | 'nonzero_exit' | 'spawn_error' | 'output_capped';
  exitCode: number | null;
  argv: string[];
  stdoutBytes: number;
  stderrBytes: number;
};

export type WakeFn = (req: WakeRequest) => Promise<WakeResult>;

export type AlertEvent = {
  kind: 'receiver_failure' | 'monitor_failure' | 'monitor_recovery';
  code: string;
};

export type AlertFn = (event: AlertEvent) => Promise<{ ok: boolean; reason?: string }>;

export type ReceiverHooks = {
  nowMs?: () => number;
  wake?: WakeFn;
  alert?: AlertFn;
  crashAfterSendBeforeCommit?: boolean;
  extraWakeEnv?: Record<string, string>;
};
