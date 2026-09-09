/** HTTP receiver: verify raw bytes, then maybe send a fixed Orca argv wake. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHttpAlert } from './alert.ts';
import { canaryTerminalBound, findRoute } from './config.ts';
import { DedupError, DedupStore, dedupKey } from './dedup.ts';
import { decodeRouteKey, isRouteKey, normalizeDomain, normalizeMailbox } from './ids.ts';
import { logEvent } from './log.ts';
import { buildNeutralWakeText, buildOrcaArgv } from './notify.ts';
import { parseVerifiedEnvelope, readMailAddress, readMailMessageId, type EnvelopeBase } from './parse.ts';
import { inspectReadiness } from './readiness.ts';
import { SeatSerializer } from './serialize.ts';
import type {
  AlertFn,
  HandleResult,
  Metrics,
  ReceiverConfig,
  ReceiverHooks,
  RouteBinding,
  WakeFn,
} from './types.ts';
import { verifyWebhookSignature } from './verify.ts';
import { createSpawnWake } from './wake.ts';

export type Receiver = {
  server: Server;
  config: ReceiverConfig;
  metrics: Metrics;
  dedup: DedupStore;
  wakes: { terminal: string; text: string; argv: string[] }[];
  close: () => Promise<void>;
  url: () => string;
};

function emptyMetrics(): Metrics {
  return {
    received: 0,
    verified: 0,
    ping: 0,
    wouldWake: 0,
    submitted: 0,
    duplicates: 0,
    ignored: 0,
    rejected: 0,
    sendFailed: 0,
    storageFailed: 0,
    alertFailed: 0,
    unauthorized: 0,
    timeoutKill: 0,
  };
}

function readBoundedBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (err: Error, closeSocket: boolean) => {
      if (done) return;
      done = true;
      req.removeAllListeners('data');
      if (closeSocket) {
        req.destroy();
      } else {
        // Drain leftover bytes without storing them so the 413 can be written.
        req.resume();
      }
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }), false);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err, true));
  });
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function shouldWake(config: ReceiverConfig, route: RouteBinding): boolean {
  if (config.mode !== 'canary') return false;
  if (!config.canaryTerminal) return false;
  return route.terminal === config.canaryTerminal;
}

export function createReceiver(config: ReceiverConfig, hooks: ReceiverHooks = {}): Receiver {
  const metrics = emptyMetrics();
  const dedup = new DedupStore(config.dedup);
  const seats = new SeatSerializer();
  const wakes: Receiver['wakes'] = [];
  const historyLimit = Math.max(0, config.wakeHistoryLimit);
  const recordWake = (entry: Receiver['wakes'][number]) => {
    hooks.onWake?.(entry);
    if (historyLimit <= 0) return;
    wakes.push(entry);
    if (wakes.length > historyLimit) {
      wakes.splice(0, wakes.length - historyLimit);
    }
  };
  const nowMs = () => hooks.nowMs?.() ?? Date.now();
  const wakeFn: WakeFn =
    hooks.wake ??
    createSpawnWake({
      timeoutMs: config.sendTimeoutMs,
      outputCapBytes: config.outputCapBytes,
      extraEnv: hooks.extraWakeEnv,
    });
  const alertFn: AlertFn = hooks.alert ?? createHttpAlert(config.alertHook.url, config.alertHook.timeoutMs);
  let inFlightHttp = 0;

  const emitAlert = async (code: string) => {
    const result = await alertFn({ kind: 'receiver_failure', code });
    if (!result.ok) {
      metrics.alertFailed += 1;
      logEvent('error', 'alert_failed', { code: result.reason ?? 'alert_failed' });
    }
  };

  const handleVerifiedMail = async (route: RouteBinding, envelope: EnvelopeBase): Promise<HandleResult> => {
    const address = readMailAddress(envelope.data);
    if (!address || address !== normalizeMailbox(route.mailbox)) {
      metrics.rejected += 1;
      await emitAlert('mapping_mismatch');
      logEvent('warn', 'mapping_mismatch', { routeKey: route.routeKey, reason: 'mailbox_mismatch' });
      return { status: 503, disposition: 'rejected', reason: 'mailbox_mismatch' };
    }
    if (normalizeDomain(envelope.domain) !== route.domain) {
      metrics.rejected += 1;
      await emitAlert('mapping_mismatch');
      logEvent('warn', 'mapping_mismatch', { routeKey: route.routeKey, reason: 'domain_mismatch' });
      return { status: 503, disposition: 'rejected', reason: 'domain_mismatch' };
    }
    if (config.mode === 'canary' && !canaryTerminalBound(config.routes, config.canaryTerminal)) {
      metrics.rejected += 1;
      await emitAlert('canary_terminal_unbound');
      logEvent('warn', 'canary_terminal_unbound', { routeKey: route.routeKey });
      return { status: 503, disposition: 'rejected', reason: 'canary_terminal_unbound' };
    }

    const key = dedupKey(route.subscriptionId, envelope.id);
    return dedup.share(key, async () => {
      try {
        const existing = await dedup.get(key, nowMs());
        if (existing) {
          metrics.duplicates += 1;
          return { status: 200, disposition: 'duplicate' };
        }
      } catch (err) {
        metrics.storageFailed += 1;
        await emitAlert('storage_failed');
        return {
          status: 503,
          disposition: 'storage_failed',
          reason: err instanceof DedupError ? err.code : 'storage_failed',
        };
      }

      return seats.run(route.terminal, async () => {
        try {
          const again = await dedup.get(key, nowMs());
          if (again) {
            metrics.duplicates += 1;
            return { status: 200, disposition: 'duplicate' };
          }
        } catch (err) {
          metrics.storageFailed += 1;
          await emitAlert('storage_failed');
          return {
            status: 503,
            disposition: 'storage_failed',
            reason: err instanceof DedupError ? err.code : 'storage_failed',
          };
        }

        const messageId = readMailMessageId(envelope.data);
        const text = buildNeutralWakeText({
          mailbox: route.mailbox,
          eventId: envelope.id,
          messageId,
        });
        const argv = buildOrcaArgv({
          orcaBinary: config.orcaBinary,
          terminal: route.terminal,
          text,
        });

        try {
          await dedup.ensureCapacity(key, nowMs());
        } catch (err) {
          metrics.storageFailed += 1;
          await emitAlert(err instanceof DedupError && err.code === 'storage_capacity' ? 'storage_capacity' : 'storage_failed');
          return {
            status: 503,
            disposition: 'storage_failed',
            reason: err instanceof DedupError ? err.code : 'storage_failed',
          };
        }

        if (!shouldWake(config, route)) {
          try {
            await dedup.commit(
              {
                key,
                status: 'observed',
                storedAtMs: nowMs(),
                expiresAtMs: nowMs() + config.dedup.retentionMs,
              },
              nowMs(),
            );
          } catch (err) {
            metrics.storageFailed += 1;
            await emitAlert(err instanceof DedupError && err.code === 'storage_capacity' ? 'storage_capacity' : 'storage_failed');
            return {
              status: 503,
              disposition: 'storage_failed',
              reason: err instanceof DedupError ? err.code : 'storage_failed',
            };
          }
          metrics.wouldWake += 1;
          logEvent('info', 'would_wake', {
            routeKey: route.routeKey,
            subscriptionId: route.subscriptionId,
            eventId: envelope.id,
            terminal: route.terminal,
          });
          return { status: 200, disposition: 'would_wake', sends: 0 };
        }

        const result = await wakeFn({ terminal: route.terminal, text, argv });
        if (result.reason === 'timeout_killed') {
          metrics.timeoutKill += 1;
        }
        if (!result.ok) {
          metrics.sendFailed += 1;
          await emitAlert(result.reason === 'timeout_killed' ? 'timeout_killed' : 'send_failed');
          logEvent('error', 'send_failed', {
            routeKey: route.routeKey,
            eventId: envelope.id,
            reason: result.reason ?? 'send_failed',
          });
          return { status: 503, disposition: 'send_failed', reason: result.reason, sends: 0 };
        }

        recordWake({ terminal: route.terminal, text, argv });

        if (hooks.crashAfterSendBeforeCommit) {
          return { status: 503, disposition: 'send_failed', reason: 'crash_after_send', submitted: true, sends: 1 };
        }

        try {
          await dedup.commit(
            {
              key,
              status: 'success',
              storedAtMs: nowMs(),
              expiresAtMs: nowMs() + config.dedup.retentionMs,
            },
            nowMs(),
          );
        } catch (err) {
          metrics.storageFailed += 1;
          await emitAlert(err instanceof DedupError && err.code === 'storage_capacity' ? 'storage_capacity' : 'storage_failed');
          return {
            status: 503,
            disposition: 'storage_failed',
            reason: err instanceof DedupError ? err.code : 'storage_failed',
            submitted: true,
            sends: 1,
          };
        }

        metrics.submitted += 1;
        logEvent('info', 'wake_submitted', {
          routeKey: route.routeKey,
          subscriptionId: route.subscriptionId,
          eventId: envelope.id,
          terminal: route.terminal,
        });
        return { status: 200, disposition: 'submitted', submitted: true, sends: 1 };
      });
    });
  };

  const handleHook = async (req: IncomingMessage, res: ServerResponse, routeKey: string): Promise<void> => {
    metrics.received += 1;
    if (!isRouteKey(routeKey)) {
      metrics.rejected += 1;
      writeJson(res, 404, { disposition: 'rejected', reason: 'unknown_route' });
      return;
    }
    const route = findRoute(config, routeKey);
    if (!route) {
      // Unknown routes never invoke the external alert sink.
      metrics.rejected += 1;
      logEvent('warn', 'unknown_mapping', { routeKey });
      writeJson(res, 404, { disposition: 'rejected', reason: 'unknown_route' });
      return;
    }

    const signatureHeader = req.headers['x-oae-signature'];
    const headerValue = Array.isArray(signatureHeader) ? signatureHeader.join(',') : signatureHeader;
    if (headerValue && headerValue.length > config.maxHeaderBytes) {
      metrics.unauthorized += 1;
      writeJson(res, 401, { disposition: 'unauthorized', reason: 'invalid_header' });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readBoundedBody(req, config.bodyLimitBytes);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'body_too_large') {
        metrics.rejected += 1;
        res.once('finish', () => {
          if (!req.destroyed) req.destroy();
        });
        writeJson(res, 413, { disposition: 'rejected', reason: 'body_too_large' });
        return;
      }
      metrics.rejected += 1;
      writeJson(res, 400, { disposition: 'invalid', reason: 'body_read_failed' });
      return;
    }

    const secrets = [route.secret, route.previousSecret].filter((s): s is string => Boolean(s));
    const verified = verifyWebhookSignature({
      signatureHeader: headerValue,
      rawBody,
      secrets,
      nowMs: nowMs(),
      toleranceSec: config.timestampToleranceSec,
      maxV1: config.maxV1Signatures,
    });
    if (!verified.valid) {
      metrics.unauthorized += 1;
      logEvent('warn', 'unauthorized', { routeKey, reason: verified.reason });
      writeJson(res, 401, { disposition: 'unauthorized', reason: verified.reason });
      return;
    }
    metrics.verified += 1;

    if (!route.active || route.stale) {
      metrics.rejected += 1;
      await emitAlert('stale_mapping');
      logEvent('warn', 'stale_mapping', { routeKey, active: route.active, stale: route.stale });
      writeJson(res, 503, { disposition: 'rejected', reason: 'stale_mapping' });
      return;
    }

    const parsed = parseVerifiedEnvelope(rawBody);
    if (!parsed.ok) {
      metrics.rejected += 1;
      writeJson(res, 400, { disposition: 'invalid', reason: parsed.reason });
      return;
    }

    if (parsed.envelope.type === 'webhook.ping') {
      metrics.ping += 1;
      logEvent('info', 'ping_ok', { routeKey, eventId: parsed.envelope.id });
      writeJson(res, 200, { disposition: 'ping_ok', sends: 0 });
      return;
    }

    if (parsed.envelope.type !== 'mail.received') {
      metrics.ignored += 1;
      logEvent('info', 'ignored_event', { routeKey, eventType: parsed.envelope.type, eventId: parsed.envelope.id });
      writeJson(res, 200, { disposition: 'ignored', reason: 'unsupported_event' });
      return;
    }

    const result = await handleVerifiedMail(route, parsed.envelope);
    writeJson(res, result.status, {
      disposition: result.disposition,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.sends != null ? { sends: result.sends } : {}),
    });
  };

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const host = req.headers.host ?? '127.0.0.1';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      writeJson(res, 400, { disposition: 'invalid', reason: 'bad_url' });
      return;
    }

    if (method === 'GET' && url.pathname === '/health') {
      writeJson(res, 200, { status: 'ok', liveness: 'ok' });
      return;
    }
    if (method === 'GET' && url.pathname === '/ready') {
      const report = inspectReadiness(config);
      writeJson(res, report.ready ? 200 : 503, report);
      return;
    }

    const hookMatch = url.pathname.match(/^\/hooks\/([^/]+)$/);
    if (method === 'POST' && hookMatch) {
      const decoded = decodeRouteKey(hookMatch[1] ?? '');
      if (!decoded.ok) {
        writeJson(res, 400, { disposition: 'invalid', reason: decoded.reason });
        return;
      }
      if (inFlightHttp >= config.maxConcurrent) {
        metrics.rejected += 1;
        writeJson(res, 503, { disposition: 'busy', reason: 'max_concurrent' });
        return;
      }
      inFlightHttp += 1;
      const timeout = setTimeout(() => {
        if (!res.headersSent) {
          writeJson(res, 503, { disposition: 'send_failed', reason: 'request_timeout' });
        }
      }, config.requestTimeoutMs);
      handleHook(req, res, decoded.value)
        .catch((err) => {
          logEvent('error', 'handler_error', { reason: err instanceof Error ? err.message : 'error' });
          if (!res.headersSent) {
            writeJson(res, 503, { disposition: 'send_failed', reason: 'handler_error' });
          }
        })
        .finally(() => {
          clearTimeout(timeout);
          inFlightHttp -= 1;
        });
      return;
    }

    writeJson(res, 404, { disposition: 'rejected', reason: 'not_found' });
  });

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 5000);
  server.keepAliveTimeout = 1000;

  return {
    server,
    config,
    metrics,
    dedup,
    wakes,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    url: () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('not_listening');
      }
      const host = addr.address === '::' ? '127.0.0.1' : addr.address;
      return `http://${host}:${addr.port}`;
    },
  };
}

export function listenReceiver(receiver: Receiver): Promise<string> {
  return new Promise((resolve, reject) => {
    receiver.server.once('error', reject);
    receiver.server.listen(receiver.config.listen.port, receiver.config.listen.host, () => {
      resolve(receiver.url());
    });
  });
}
