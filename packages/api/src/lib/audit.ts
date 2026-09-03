/**
 * Scrubbed 审计事件（WriteGuard 对照）。
 *
 * 落盘：DATA_DIR/audit.jsonl——JSONL **追加写**（与 identities/oauth-store 的
 * JSON 整文件 tmp+rename 不同，故不抽第三份通用存储工具；纪律仍对齐：
 * 单写者进程、目录 0700、文件 0600、绝不记录参数值/正文/token 片段）。
 *
 * 外部可控字符串（clientId/grantId/address/tool/event）写入前剥控制字符与换行，
 * 防 JSONL log 注入（\r\n 伪造行）。
 *
 * 增长策略：单文件超过 AUDIT_ROTATE_BYTES（10MB）时 rename 为 audit.jsonl.1
 *（只留一份备份），再开新 audit.jsonl。读端合并 .1 + 当前（新的在前）。
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

/** 超过此大小则 rotate（只保留 audit.jsonl.1 一份）。 */
export const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;

/** 审计行 outcome：放行 / 策略拒绝 / 限量 / 执行层错误。 */
export type AuditOutcome = 'ok' | 'denied' | 'rate_limited' | 'error';

/**
 * Scrubbed 行。字段白名单即红线：禁止扩展出 args/body/token/subject 等。
 * clientId/grantId/address/tool/tier 均可选——按事件类型填已知标识即可。
 */
export type AuditEvent = {
  ts: string;
  event: string;
  clientId?: string;
  grantId?: string;
  address?: string;
  tool?: string;
  tier?: string;
  outcome: AuditOutcome;
  durationMs?: number;
  /** 客户端 IP（非秘密；OAuth 端点事件可选带上）。 */
  ip?: string;
  /** 变更后的 scope 集合（scrubbed 字符串数组）。 */
  scopes?: string[];
};

function auditPath(): string {
  return join(config.dataDir, 'audit.jsonl');
}

function auditRotatedPath(): string {
  return join(config.dataDir, 'audit.jsonl.1');
}

/**
 * 清洗外部可控字段：去掉 C0 控制字符与 DEL（含 \r\n\t），再截断。
 * JSON.stringify 本身会转义换行，但落盘前仍剥除，避免伪造「下一行」观感/下游误解析。
 */
export function scrubAuditField(value: string, maxLen = 256): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLen);
}

/** 确保 DATA_DIR 0700；单写者约定与 identities 相同。 */
function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // bind mount 属主可能不同；文件 mode 仍会设置
  }
}

/** 必要时 rotate：>10MB → audit.jsonl.1（覆盖旧备份），再新建空文件。 */
function rotateIfNeeded(): void {
  const path = auditPath();
  if (!existsSync(path)) return;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= AUDIT_ROTATE_BYTES) return;
  const rotated = auditRotatedPath();
  try {
    renameSync(path, rotated);
    chmodSync(rotated, 0o600);
  } catch {
    // rotate 失败不阻断主路径；下一次写入再试
  }
}

/**
 * 追加一条 scrubbed 事件。写入失败只打日志，不抛——审计不得拖垮授权/MCP。
 */
export function recordAuditEvent(
  partial: Omit<AuditEvent, 'ts'> & { ts?: string },
): void {
  const row: AuditEvent = {
    ts: partial.ts ?? new Date().toISOString(),
    event: scrubAuditField(partial.event, 128),
    outcome: partial.outcome,
    ...(partial.clientId !== undefined
      ? { clientId: scrubAuditField(partial.clientId) }
      : {}),
    ...(partial.grantId !== undefined
      ? { grantId: scrubAuditField(partial.grantId) }
      : {}),
    ...(partial.address !== undefined
      ? { address: scrubAuditField(partial.address) }
      : {}),
    ...(partial.tool !== undefined
      ? { tool: scrubAuditField(partial.tool, 128) }
      : {}),
    ...(partial.tier !== undefined
      ? { tier: scrubAuditField(partial.tier, 32) }
      : {}),
    ...(partial.durationMs !== undefined ? { durationMs: partial.durationMs } : {}),
    // IP 非秘密；仍剥控制字符并截断（IPv6 字面量 + zone id 足够 64）
    ...(partial.ip !== undefined ? { ip: scrubAuditField(partial.ip, 64) } : {}),
    ...(partial.scopes !== undefined
      ? { scopes: partial.scopes.map((s) => scrubAuditField(s, 64)) }
      : {}),
  };

  try {
    ensureDataDir();
    rotateIfNeeded();
    const path = auditPath();
    const line = `${JSON.stringify(row)}\n`;
    if (!existsSync(path)) {
      // 新建时显式 0600（append 对已存在文件不改 mode）
      writeFileSync(path, line, { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort
      }
      return;
    }
    appendFileSync(path, line, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  } catch (err) {
    console.error('[audit] append failed:', err);
  }
}

export type ReadAuditOptions = {
  /** 默认 100，上限 1000。 */
  limit?: number;
  /** 精确匹配 event 字段。 */
  event?: string;
};

function parseAuditLines(text: string): AuditEvent[] {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const out: AuditEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as AuditEvent;
      if (typeof parsed.ts !== 'string' || typeof parsed.event !== 'string') continue;
      if (typeof parsed.outcome !== 'string') continue;
      out.push(parsed);
    } catch {
      // 跳过坏行
    }
  }
  return out;
}

/**
 * 读端：合并 audit.jsonl.1（旧）+ audit.jsonl（新），**新的在前**，尊重 limit。
 * 可选 event 精确过滤。只读，无删除 API。
 */
export function readAuditEvents(options: ReadAuditOptions = {}): AuditEvent[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 0), 1000);
  if (limit === 0) return [];

  // 时间序：旧文件在前、当前在后；再从尾部取 → 新的优先
  const chunks: AuditEvent[] = [];
  for (const path of [auditRotatedPath(), auditPath()]) {
    if (!existsSync(path)) continue;
    try {
      chunks.push(...parseAuditLines(readFileSync(path, 'utf8')));
    } catch {
      // 跳过不可读文件
    }
  }

  const filtered = options.event
    ? chunks.filter((e) => e.event === options.event)
    : chunks;

  // 新的在前：从末尾往回取 limit 条，保持新→旧顺序
  const newestFirst: AuditEvent[] = [];
  for (let i = filtered.length - 1; i >= 0 && newestFirst.length < limit; i--) {
    newestFirst.push(filtered[i]!);
  }
  return newestFirst;
}

/** 测试辅助：清空当前审计文件与 rotate 备份。 */
export function resetAuditForTests(): void {
  for (const path of [auditPath(), auditRotatedPath()]) {
    if (existsSync(path)) {
      writeFileSync(path, '', { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        // ignore
      }
    }
  }
}
