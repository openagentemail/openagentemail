/**
 * Diagnostics for the server log.
 *
 * Errors from the mail stack can carry the server's own responses, adapter
 * context and — depending on the adapter — the credentials it was configured
 * with. Those belong in the operator's log, never in an API response, and the
 * configured passwords should not be in either.
 */

import { config } from './config.ts';

function configuredSecrets(): string[] {
  return [config.smtp.pass, config.imap.pass];
}

/**
 * Replace secrets with a marker. Defaults to the configured mail passwords.
 *
 * Every non-empty secret is redacted regardless of length. A short password is
 * still a password — config only requires min(1) — and skipping those (an
 * earlier attempt did, to keep the log readable) means the weakest credentials
 * are exactly the ones that end up in the log verbatim. A noisy log beats a
 * leaked one. Longest first, so a secret that contains another one is not
 * chopped up into a partially readable form.
 */
export function redactSecrets(text: string, secrets: string[] = configuredSecrets()): string {
  let out = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * One-line description of a failure: SMTP/adapter code, response code and
 * message, with configured secrets scrubbed.
 *
 * 永不抛：病态 rejection（会抛 getter / revoked Proxy / 不可字符串化）⇒ `[unreadable]`。
 * 正常输入行为与历史逐字节一致。
 */
export function describeFailure(err: unknown, secrets?: string[]): string {
  try {
    const e = (err ?? {}) as { message?: unknown; code?: unknown; responseCode?: unknown };
    const parts = [
      typeof e.code === 'string' ? e.code : undefined,
      typeof e.responseCode === 'number' ? String(e.responseCode) : undefined,
      typeof e.message === 'string' && e.message ? e.message : undefined,
    ].filter((part): part is string => Boolean(part));
    const line = parts.length > 0 ? parts.join(' ') : String(err);
    return secrets ? redactSecrets(line, secrets) : redactSecrets(line);
  } catch {
    return '[unreadable]';
  }
}

/** 单趟取前 n 个码点，不满则原样；不物化超量尾部 */
function takeCodePoints(text: string, n: number): string {
  if (n <= 0) return '';
  let out = '';
  let c = 0;
  for (const ch of text) {
    if (c >= n) break;
    out += ch;
    c += 1;
  }
  return out;
}

/**
 * 日志专用：有界截取 code/message → 先剥边界密钥真前缀 → 再 redactSecrets → 再剥一次。
 * 防：①截断切开长密钥后短密钥误匹配留下碎片；②超大 code 无界分配。
 * 不改变 `describeFailure` 既有语义；永不抛。
 */
export function describeFailureBounded(
  err: unknown,
  maxMessagePts = 400,
  secrets?: string[],
): string {
  try {
    const secs = secrets ?? configuredSecrets();
    const maxSecretLen = secs.reduce((m, s) => Math.max(m, s ? s.length : 0), 0);
    const budget = Math.max(0, maxMessagePts) + maxSecretLen;
    const e = (err ?? {}) as { message?: unknown; code?: unknown; responseCode?: unknown };
    let code: string | undefined;
    let responseCode: string | undefined;
    let message: string | undefined;
    try {
      // code 与 message 同等有界，避免大 code 绕过预算
      if (typeof e.code === 'string' && e.code) code = takeCodePoints(e.code, budget);
    } catch { /* ignore */ }
    try {
      if (typeof e.responseCode === 'number') responseCode = String(e.responseCode);
    } catch { /* ignore */ }
    try {
      const raw = e.message;
      if (typeof raw === 'string' && raw) message = takeCodePoints(raw, budget);
    } catch { /* ignore */ }
    const parts = [code, responseCode, message].filter((p): p is string => Boolean(p));
    let line: string;
    if (parts.length > 0) {
      line = parts.join(' ');
    } else {
      try {
        line = takeCodePoints(String(err), budget);
      } catch {
        return '[unreadable]';
      }
    }
    // 脱敏前先剥「非完整密钥」的尾缀，避免短密钥在长密钥残段上误匹配
    line = scrubTrailingSecretPrefix(line, secs);
    line = redactSecrets(line, secs);
    return scrubTrailingSecretPrefix(line, secs);
  } catch {
    return '[unreadable]';
  }
}

/**
 * 若 text 以某配置密钥的真前缀结尾（且该前缀本身不是另一完整密钥），剥掉该尾缀。
 * 最长密钥优先；可叠剥多次。
 */
function scrubTrailingSecretPrefix(text: string, secrets: string[]): string {
  const fullSecrets = new Set([...secrets].filter(Boolean));
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const secret of [...fullSecrets].sort((a, b) => b.length - a.length)) {
      const maxLen = Math.min(secret.length - 1, out.length);
      for (let len = maxLen; len >= 1; len--) {
        const suf = secret.slice(0, len);
        // 完整短密钥留给 redactSecrets；只剥「非完整密钥」的真前缀
        if (out.endsWith(suf) && !fullSecrets.has(suf)) {
          out = out.slice(0, -len);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return out;
}
