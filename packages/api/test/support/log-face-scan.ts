/**
 * #344 R1 / #347：对象面裸用扫描（跨行 + 变量名放宽）。
 * 声明口径：「本卡对象面入口处已收口；其余白名单钉 #347」。
 */

/** #347 记债白名单：针头字符串（不钉行号，防漂移）
 * 残余：dead-letter logErr + 三处 HIGH alert 的 detail 对象面。
 */
export const OBJECT_FACE_DEBT_NEEDLES = [
  'failed to write executeJob dead letter',
  '[send-log] HIGH:',
  '[notification-log] HIGH:',
  '[notification-devices] HIGH:',
] as const;

export const OBJECT_FACE_DEBT_ISSUE = '#347';

/** 从 console.X( 起括号匹配，返回参数原文与起点 */
export function extractConsoleCalls(
  text: string,
): Array<{ kind: string; args: string; index: number }> {
  const out: Array<{ kind: string; args: string; index: number }> = [];
  const re = /console\.(warn|error|log)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i++]!;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch;
        while (i < text.length) {
          const c = text[i++]!;
          if (c === '\\') {
            i++;
            continue;
          }
          if (c === q) break;
        }
      }
    }
    out.push({
      kind: m[1]!,
      args: text.slice(m.index + m[0].length, i - 1),
      index: m.index,
    });
  }
  return out;
}

/** 顶层参数列表（忽略字符串/模板内逗号） */
function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let depth = 0;
  let i = 0;
  while (i < args.length) {
    const ch = args[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      cur += ch;
      i++;
      while (i < args.length) {
        const c = args[i++]!;
        cur += c;
        if (c === '\\') {
          if (i < args.length) cur += args[i++]!;
          continue;
        }
        if (c === q) break;
      }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * 是否为对象面裸用：顶层参数中**任一**恰为 `\w*[Ee]rr\w*` 或 `detail`。
 * 按参数判定（不看整段是否含 describeFailure*）——避免
 * `describeFailureStack(err), err` 这类混合调用被整段捷径豁免。
 */
export function isObjectFaceBareArgs(args: string): boolean {
  for (const p of splitTopLevelArgs(args)) {
    if (/^detail$/.test(p)) return true;
    if (/^\w*[Ee]rr\w*$/.test(p)) return true;
  }
  return false;
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** 命中是否属于 #347 白名单（按针头） */
export function isObjectFaceDebtAllowed(callSrc: string): boolean {
  return OBJECT_FACE_DEBT_NEEDLES.some((n) => callSrc.includes(n));
}
