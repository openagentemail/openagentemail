/**
 * 发信线程字段，以及入站详情上的 messageId / references。
 * 只依赖 zod，stdio MCP 可以安全导入，不会在加载时解析服务端 env。
 * msg-id 正则只写在这一处，发信 schema 和读信详情共用。
 */
import { z } from 'zod';

/** 单个 msg-id 的最大长度（含尖括号），与主题上限同为 998。 */
export const RFC5322_MSG_ID_MAX = 998;

/** references 条数上限。 */
export const REFERENCES_MAX_COUNT = 50;

/**
 * references 用单个空格拼成头值后的最大长度。
 * 不含字段名，也不把稍后追加的 inReplyTo 算进去。
 */
export const REFERENCES_JOINED_MAX = 8000;

/**
 * 尖括号形式的一个 msg-id：<id-left@id-right>。
 * 字符类是可打印 ASCII，但去掉空白、控制字符，以及尖括号内部的 < > @。
 * `!`–`;`、`=`、`?`、`A`–`~` 合在一起恰好跳过 `<` `>` `@`。
 * 两侧都至少有一个字符，因此恰好一个 @。
 */
const RFC5322_MSG_ID_RE = /^<[!-;=?A-~]+@[!-;=?A-~]+>$/;

/**
 * 与下面的 zod schema 同一条规则：长度不超过 998，且匹配尖括号 msg-id。
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
