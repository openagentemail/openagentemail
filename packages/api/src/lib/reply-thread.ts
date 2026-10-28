/**
 * 发信线程字段，以及入站详情上的 messageId / references。
 * 只依赖 zod，stdio MCP 可以安全导入，不会在加载时解析服务端 env。
 * msg-id 正则只写在这一处，发信 schema 和读信详情共用。
 */
import { z } from 'zod';

/**
 * 单个 msg-id 的最大长度（含尖括号）。
 * RFC 5322 的 998 是物理行上限。msg-id 中间没有空白，折不进续行，
 * 所以一条 id 收到 250，避免单条就把 In-Reply-To / References 撑过一行。
 */
export const RFC5322_MSG_ID_MAX = 250;

/** references 条数上限。 */
export const REFERENCES_MAX_COUNT = 50;

/**
 * references 用单个空格拼成头值后的最大长度。
 * 不含字段名，也不把稍后追加的 inReplyTo 算进去。
 */
export const REFERENCES_JOINED_MAX = 8000;

/**
 * 不含过时写法的 RFC 5322 msg-id：`<` id-left `@` id-right `>`。
 * id-left 只能是 dot-atom-text。id-right 是 dot-atom-text，或 no-fold-literal（`[` dtext* `]`）。
 * atext 不含逗号、引号、反斜杠、空白和尖括号。dot-atom-text 不允许空段、首尾点或连续点。
 * dtext 是可打印 ASCII，去掉空格、`[`、`\`、`]`。
 */
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const DOT_ATOM_TEXT = `${ATEXT}+(?:\\.${ATEXT}+)*`;
const DTEXT = '[\\x21-\\x5A\\x5E-\\x7E]';
const NO_FOLD_LITERAL = `\\[${DTEXT}*\\]`;
const RFC5322_MSG_ID_RE = new RegExp(
  `^<${DOT_ATOM_TEXT}@(?:${DOT_ATOM_TEXT}|${NO_FOLD_LITERAL})>$`,
);

/**
 * 与下面的 zod schema 同一条规则：长度不超过 250，且匹配上面的 msg-id。
 * 读信详情用它过滤，避免再抄一份正则。非字符串由调用方先丢掉。
 */
export function isRfc5322MsgId(value: string): boolean {
  return value.length <= RFC5322_MSG_ID_MAX && RFC5322_MSG_ID_RE.test(value);
}

/** 一个 RFC 5322 msg-id，必须已经带尖括号。 */
export const rfc5322MsgIdSchema = z
  .string()
  .max(RFC5322_MSG_ID_MAX)
  .regex(RFC5322_MSG_ID_RE, 'must be one RFC 5322 msg-id in angle brackets');

/** 1..50 个 msg-id，空格拼接后不超过 8000。 */
export const replyReferencesSchema = z
  .array(rfc5322MsgIdSchema)
  .min(1)
  .max(REFERENCES_MAX_COUNT)
  .superRefine((ids, ctx) => {
    if (ids.join(' ').length <= REFERENCES_JOINED_MAX) return;
    ctx.addIssue({
      code: 'custom',
      message: 'joined references exceed 8000 characters',
    });
  });

type ThreadingFields = {
  inReplyTo?: string;
  references?: readonly string[];
};

type IssueCtx = {
  addIssue: (issue: { code: 'custom'; message: string; path: string[] }) => void;
};

/** mailparser 的 references 可能是一条字符串，也可能是数组。其它类型忽略。 */
function referenceCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
  }
  return out;
}

/**
 * 入站详情上的线程字段。只看这封信自己的 Message-ID 和 References。
 * 不把 Message-ID 或 In-Reply-To 自动补进 references。
 * 非法或缺失的 messageId 省略。references 先丢掉非法项，再按原顺序去重（留第一次），
 * 超过 50 条时保留最后 50 条；一条合法的都没有则省略。
 */
export function detailThreadFields(input: {
  messageId?: unknown;
  references?: unknown;
}): { messageId?: string; references?: string[] } {
  const messageId =
    typeof input.messageId === 'string' && isRfc5322MsgId(input.messageId)
      ? input.messageId
      : undefined;
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of referenceCandidates(input.references)) {
    if (!isRfc5322MsgId(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  // 负数下标：不足 50 时原样返回，更长时只留末尾 50 个。
  const references = unique.length === 0 ? undefined : unique.slice(-REFERENCES_MAX_COUNT);
  return {
    ...(messageId ? { messageId } : {}),
    ...(references ? { references } : {}),
  };
}

/** references 单独出现时拒绝。inReplyTo 可以单独出现。 */
export function rejectReferencesWithoutInReplyTo(data: ThreadingFields, ctx: IssueCtx): void {
  if (data.references === undefined || data.inReplyTo !== undefined) return;
  ctx.addIssue({
    code: 'custom',
    path: ['references'],
    message: 'references requires inReplyTo',
  });
}

/**
 * References 头的最终 id 列表。
 * 调用方给的列表按原顺序去重；inReplyTo 若不是最后一项就再追加一次。
 * 没给 references 时，头里只有 inReplyTo。
 */
export function referencesForReply(inReplyTo: string, references?: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of references ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0 || out[out.length - 1] !== inReplyTo) out.push(inReplyTo);
  return out;
}
