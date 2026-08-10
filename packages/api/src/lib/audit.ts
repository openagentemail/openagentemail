/**
 * Scrubbed 审计事件（WriteGuard 对照）。
 *
 * 落盘：DATA_DIR/audit.jsonl——JSONL **追加写**（与 identities/oauth-store 的
 * JSON 整文件 tmp+rename 不同，故不抽第三份通用存储工具；纪律仍对齐：
 * 单写者进程、目录 0700、文件 0600、绝不记录参数值/正文/token 片段）。
 *
 * 增长策略：单文件超过 AUDIT_ROTATE_BYTES（10MB）时 rename 为 audit.jsonl.1
 *（只留一份备份），再开新 audit.jsonl。注释与 docs/security.md 同步。
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
};

function auditPath(): string {
  return join(config.dataDir, 'audit.jsonl');
}

function auditRotatedPath(): string {
  return join(config.dataDir, 'audit.jsonl.1');
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
    event: partial.event,
    outcome: partial.outcome,
    ...(partial.clientId !== undefined ? { clientId: partial.clientId } : {}),
    ...(partial.grantId !== undefined ? { grantId: partial.grantId } : {}),
    ...(partial.address !== undefined ? { address: partial.address } : {}),
    ...(partial.tool !== undefined ? { tool: partial.tool } : {}),
    ...(partial.tier !== undefined ? { tier: partial.tier } : {}),
    ...(partial.durationMs !== undefined ? { durationMs: partial.durationMs } : {}),
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

/**
 * 读端：从文件尾部取最近 N 条（可选 event 过滤）。只读，无删除 API。
 */
export function readAuditEvents(options: ReadAuditOptions = {}): AuditEvent[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 0), 1000);
  if (limit === 0) return [];
  const path = auditPath();
  if (!existsSync(path)) return [];

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const out: AuditEvent[] = [];
  // 从尾部往前扫，凑够 limit
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as AuditEvent;
      if (options.event && parsed.event !== options.event) continue;
      if (typeof parsed.ts !== 'string' || typeof parsed.event !== 'string') continue;
      if (typeof parsed.outcome !== 'string') continue;
      out.push(parsed);
    } catch {
      // 跳过坏行
    }
  }
  // 时间正序返回（旧→新）
  out.reverse();
  return out;
}

/** 测试辅助：清空审计文件（不删 rotate 备份，测试一般用新 DATA_DIR）。 */
export function resetAuditForTests(): void {
  const path = auditPath();
  if (existsSync(path)) {
    writeFileSync(path, '', { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // ignore
    }
  }
}
