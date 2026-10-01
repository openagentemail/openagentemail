/**
 * 入站 Auto-Submitted 有界分类（RFC 3834 抑制信号，不是认证来源）。
 * source:internal 是 HMAC 来源戳，不能代替本字段，也不能证明这封信是自动回复。
 * 返回值只允许五个枚举；不回传攻击者控制的原始头。
 */
export type AutoSubmitted = null | 'no' | 'auto-generated' | 'auto-replied' | 'other';

function classifyOne(line: string): Exclude<AutoSubmitted, null> {
  // 展开折叠空白后再取冒号后的值；扩展参数、注释、空白或未知 token 一律 other。
  const unfolded = line.replace(/\r?\n[ \t]+/g, ' ');
  const colon = unfolded.indexOf(':');
  const raw = (colon < 0 ? unfolded : unfolded.slice(colon + 1)).trim();
  if (!/^[A-Za-z-]+$/.test(raw)) return 'other';
  const token = raw.toLowerCase();
  if (token === 'no' || token === 'auto-generated' || token === 'auto-replied') return token;
  return 'other';
}

/** 检查每一条大小写不敏感的 Auto-Submitted。缺头为 null；no 与任何非 no 冲突则 other。 */
export function classifyAutoSubmitted(
  headerLines: ReadonlyArray<{ key: string; line: string }> | undefined | null,
): AutoSubmitted {
  const values: Array<Exclude<AutoSubmitted, null>> = [];
  for (const header of headerLines ?? []) {
    if (header.key.toLowerCase() !== 'auto-submitted') continue;
    values.push(classifyOne(header.line));
  }
  if (values.length === 0) return null;
  return values.every((value) => value === values[0]) ? values[0]! : 'other';
}
