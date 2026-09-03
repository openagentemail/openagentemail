// MCP 工具 schema 必须和 REST API 的契约一致：schema 放行、服务端却拒绝的
// 输入，只会让 agent 拿到一个 400，而不是它要的数据。
//
// 这里把 SDK 换成假的，好把 registerTool() 的配置抓出来直接断言。
import { expect, mock, test } from "bun:test";
import { z } from "zod";
// 用 API 真实返回类型约束夹具：形状漂移在编译期就红，杜绝手写自证。
import type { MessageDetail, MessageSummary } from "../../api/src/lib/imap.ts";

type SchemaMap = Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: SchemaMap;
  outputSchema?: SchemaMap;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

const toolSchemas = new Map<string, SchemaMap>();
const toolConfigs = new Map<string, ToolConfig>();

class FakeMcpServer {
  registerTool(name: string, config: ToolConfig) {
    toolConfigs.set(name, config);
    toolSchemas.set(name, config.inputSchema ?? {});
  }

  async connect() {}
}

mock.module("@modelcontextprotocol/server", () => ({ McpServer: FakeMcpServer }));
mock.module("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: class {},
}));

process.env.OPENAGENTEMAIL_API_KEY = "test-key";
await import("../src/main.ts");

test("#56/#58 tools registry/schema metadata", () => {
  const expected = [
    "mail_new_identity",
    "mail_list_identities",
    "mail_list_messages",
    "mail_read_message",
    "mail_mark_seen",
    "mail_wait_for",
    "mail_send",
    "notify_user",
    "notify_agent",
    "notify_check",
    "notify_verify",
    "task_create",
    "task_list_children",
    "task_list",
    "task_get",
    "task_update",
    "task_decide",
    "task_claim",
    "task_renew",
    "task_release",
  ];
  const missingLeaseTools = ["task_claim", "task_renew", "task_release"].filter(
    (name) => !toolConfigs.has(name),
  );
  // Keep this inventory RED behavior-level and named. Do not fall through to
  // undefined configs, which turns a missing production registration into a
  // TypeError rather than its own actionable contract failure.
  if (missingLeaseTools.length > 0) {
    expect(missingLeaseTools, "#56 lease tool inventory must register claim/renew/release").toEqual([]);
    return;
  }
  expect([...toolConfigs.keys()]).toEqual(expected);

  for (const config of toolConfigs.values()) {
    expect(config.title).toBeTruthy();
    expect(config.outputSchema).toBeDefined();
    expect(config.annotations).toBeDefined();
    expect(config.annotations?.openWorldHint).toBe(true);
  }

  expect(toolConfigs.get("mail_list_messages")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("mail_send")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("mail_send")?.annotations?.destructiveHint).toBe(false);
  expect(toolConfigs.get("mail_mark_seen")?.annotations?.destructiveHint).toBe(false);
  expect(toolConfigs.get("mail_mark_seen")?.annotations?.idempotentHint).toBe(true);
  expect(toolConfigs.get("notify_check")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("notify_user")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_list")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("task_get")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("task_create")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_update")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_decide")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_claim")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_renew")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_release")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("mail_read_message")?.outputSchema).toBe(
    toolConfigs.get("mail_wait_for")?.outputSchema,
  );
});

test("读信类工具带 untrustedContentHint，description 钉死 fail-closed 可信口径", () => {
  for (const name of ["mail_list_messages", "mail_read_message", "mail_wait_for"] as const) {
    const config = toolConfigs.get(name);
    expect(config?.annotations?.untrustedContentHint).toBe(true);
    expect(config?.description ?? "").toContain("untrusted");
    expect(config?.description ?? "").toContain("source=internal");
    expect(config?.description ?? "").toContain("missing/unknown/external");
  }
  const listDesc = toolConfigs.get("mail_list_messages")?.description ?? "";
  // F1：snippet 已围栏，不得再声称 not fenced。
  expect(listDesc).not.toContain("Snippets are not fenced");
  expect(listDesc).toContain("Non-internal snippets are fenced");
  expect(listDesc).toContain("hasOtp");
  expect(listDesc).toContain("source");
  // 非读信工具不应误标。
  expect(toolConfigs.get("mail_send")?.annotations?.untrustedContentHint).toBeUndefined();
});

test("mail_list_messages limit 不能超出 REST API 接受的范围", () => {
  const limit = toolSchemas.get("mail_list_messages")!.limit;
  expect(limit.safeParse(1).success).toBe(true);
  expect(limit.safeParse(50).success).toBe(true);
  expect(limit.safeParse(200).success).toBe(true);
  // GET /v1/messages 的 zod 是 .max(200)，201 会被服务端以 400 拒掉。
  expect(limit.safeParse(201).success).toBe(false);
  expect(limit.safeParse(500).success).toBe(false);
});

test('#58 R3 RED: task tools accept the authenticated parent pointer and expose bounded direct-child reads', () => {
  const taskCreate = toolSchemas.get('task_create');
  const children = toolSchemas.get('task_list_children');
  expect(taskCreate, 'task_create must retain REST parentTaskId parity').toBeDefined();
  expect(taskCreate!.parentTaskId.safeParse('f0c4a8e6-1e22-4c66-8c2f-0955a20d81bf').success).toBe(true);
  expect(taskCreate!.parentTaskId.safeParse('not-a-uuid').success).toBe(false);
  expect(taskCreate!.parentTaskId.safeParse('018f8d1d-4d7e-7b0a-8000-000000000000').success).toBe(false);
  expect(taskCreate!.parentTaskId.safeParse('018f8d1d-4d7e-8b0a-8000-000000000000').success).toBe(false);
  expect(children, 'task_list_children must be registered').toBeDefined();
  expect(children!.parentTaskId.safeParse('f0c4a8e6-1e22-4c66-8c2f-0955a20d81bf').success).toBe(true);
  expect(children!.parentTaskId.safeParse('018f8d1d-4d7e-7b0a-8000-000000000000').success).toBe(false);
  expect(children!.parentTaskId.safeParse('018f8d1d-4d7e-8b0a-8000-000000000000').success).toBe(false);
  expect(children!.limit.safeParse(20).success).toBe(true);
  expect(children!.limit.safeParse(21).success).toBe(false);
});

test("工具入参约束要和 REST API 对齐，别把服务端必拒的值放过去", () => {
  const ok = (schema: SchemaMap, field: string, value: unknown) =>
    schema[field]!.safeParse(value).success;

  const newIdentity = toolSchemas.get("mail_new_identity")!;
  expect(ok(newIdentity, "name", "Fox")).toBe(true);
  expect(ok(newIdentity, "name", "")).toBe(false); // API: z.string().min(1)
  expect(ok(newIdentity, "name", "x".repeat(101))).toBe(false); // API: .max(100)
  expect(ok(newIdentity, "localpart", "my-bot")).toBe(true);
  expect(ok(newIdentity, "localpart", "qoder-cn-mbp")).toBe(true);
  expect(ok(newIdentity, "localpart", "My-Bot")).toBe(false); // uppercase not allowed
  expect(ok(newIdentity, "localpart", "-bot")).toBe(false); // must start alphanumeric
  expect(ok(newIdentity, "localpart", "a".repeat(64))).toBe(false); // max 63 chars

  const list = toolSchemas.get("mail_list_messages")!;
  expect(ok(list, "address", "fox-k7d2@test.example")).toBe(true);
  expect(ok(list, "address", "not-an-email")).toBe(false);

  const read = toolSchemas.get("mail_read_message")!;
  expect(ok(read, "id", "7")).toBe(true);
  expect(ok(read, "id", "../7")).toBe(false); // 服务端 Number(id) 会判非法
  expect(ok(read, "id", "0")).toBe(false);
  expect(ok(read, "address", "not-an-email")).toBe(false);

  const markSeen = toolSchemas.get("mail_mark_seen")!;
  expect(markSeen).toBeDefined();
  expect(ok(markSeen, "id", "7")).toBe(true);
  expect(ok(markSeen, "id", "../7")).toBe(false);
  expect(ok(markSeen, "id", "0")).toBe(false);
  expect(ok(markSeen, "address", "not-an-email")).toBe(false);
  expect(ok(markSeen, "seen", true)).toBe(true);
  expect(ok(markSeen, "seen", false)).toBe(true);
  expect(ok(markSeen, "seen", "yes")).toBe(false); // API: z.boolean()

  const waitFor = toolSchemas.get("mail_wait_for")!;
  expect(ok(waitFor, "address", "not-an-email")).toBe(false);
  expect(ok(waitFor, "fromContains", "x".repeat(200))).toBe(true);
  expect(ok(waitFor, "fromContains", "x".repeat(201))).toBe(false); // API: .max(200)
  expect(ok(waitFor, "subjectContains", "x".repeat(201))).toBe(false);

  const send = toolSchemas.get("mail_send")!;
  expect(ok(send, "from", "not-an-email")).toBe(false);
  expect(ok(send, "to", "not-an-email")).toBe(false);
  expect(ok(send, "subject", "x".repeat(998))).toBe(true);
  expect(ok(send, "subject", "x".repeat(999))).toBe(false); // API: .max(998)
  expect(ok(send, "text", "x".repeat(1_000_001))).toBe(false); // API: .max(1_000_000)
  expect(ok(send, "html", "x".repeat(1_000_001))).toBe(false);

  const notifyUser = toolSchemas.get("notify_user")!;
  expect(ok(notifyUser, "title", "wake")).toBe(true);
  expect(ok(notifyUser, "title", "")).toBe(false);
  expect(ok(notifyUser, "message", "x".repeat(4_000))).toBe(true);
  expect(ok(notifyUser, "message", "x".repeat(4_001))).toBe(false);
  expect(ok(notifyUser, "level", "urgent")).toBe(true);
  expect(ok(notifyUser, "level", "loud")).toBe(false);

  const notifyAgent = toolSchemas.get("notify_agent")!;
  expect(ok(notifyAgent, "name", "qa-bot")).toBe(true);
  expect(ok(notifyAgent, "name", "QA-Bot")).toBe(false);
  expect(ok(notifyAgent, "name", "-bot")).toBe(false);

  const taskCreate = toolSchemas.get("task_create")!;
  expect(ok(taskCreate, "to", "bravo@test.example")).toBe(true);
  expect(ok(taskCreate, "to", "not-an-email")).toBe(false);
  expect(ok(taskCreate, "subject", "x".repeat(998))).toBe(true);
  expect(ok(taskCreate, "subject", "x".repeat(999))).toBe(false);
  expect(ok(taskCreate, "body", "x".repeat(1_000_001))).toBe(false);
  expect(ok(taskCreate, "wait", true)).toBe(true);
  expect(ok(taskCreate, "wait", "yes")).toBe(false);

  const taskUpdate = toolSchemas.get("task_update")!;
  expect(ok(taskUpdate, "id", "0fdc3207-056e-47c1-a65c-b29d39f66b83")).toBe(true);
  expect(ok(taskUpdate, "id", "not-a-task")).toBe(false);
  expect(ok(taskUpdate, "state", "input-required")).toBe(true);
  expect(ok(taskUpdate, "state", "reopened")).toBe(false);
  expect(ok(taskUpdate, "body", "x".repeat(1_000_001))).toBe(false);

  const taskDecide = toolSchemas.get("task_decide")!;
  expect(ok(taskDecide, "id", "0fdc3207-056e-47c1-a65c-b29d39f66b83")).toBe(true);
  expect(ok(taskDecide, "decision", "approved")).toBe(true);
  expect(ok(taskDecide, "decision", "execute")).toBe(false);

  const taskClaim = toolSchemas.get("task_claim");
  const taskRenew = toolSchemas.get("task_renew");
  const taskRelease = toolSchemas.get("task_release");
  if (!taskClaim || !taskRenew || !taskRelease) {
    expect(
      { task_claim: !!taskClaim, task_renew: !!taskRenew, task_release: !!taskRelease },
      "#56 lease schemas require registered claim/renew/release tools",
    ).toEqual({ task_claim: true, task_renew: true, task_release: true });
    return;
  }
  expect(ok(taskClaim, "id", "0fdc3207-056e-47c1-a65c-b29d39f66b83")).toBe(true);
  expect(ok(taskClaim, "leaseSec", 120)).toBe(true);
  expect(ok(taskClaim, "leaseSec", 0)).toBe(false);

  expect(ok(taskRenew, "id", "0fdc3207-056e-47c1-a65c-b29d39f66b83")).toBe(true);
  expect(ok(taskRenew, "leaseToken", "opaque-current-lease-token")).toBe(true);
  expect(ok(taskRenew, "leaseSec", 120)).toBe(true);

  expect(ok(taskRelease, "id", "0fdc3207-056e-47c1-a65c-b29d39f66b83")).toBe(true);
  expect(ok(taskRelease, "leaseToken", "opaque-current-lease-token")).toBe(true);
  expect(ok(taskRelease, "reason", "worker stopped")).toBe(true);
});

test("#79 task_update schema forwards every supplied string to the shared lease fence", () => {
  const taskUpdate = toolSchemas.get("task_update");
  if (!taskUpdate) {
    expect(taskUpdate, "R12 task_update must be registered before leaseToken schema is checked").toBeDefined();
    return;
  }
  const leaseToken = taskUpdate.leaseToken;
  if (!leaseToken) {
    expect(leaseToken, "R12 task_update must publish its optional leaseToken schema").toBeDefined();
    return;
  }
  expect({
    opaqueToken: leaseToken.safeParse("opaque-current-lease-token").success,
    emptyToken: leaseToken.safeParse("").success,
    oversizedToken: leaseToken.safeParse("x".repeat(16_385)).success,
    omittedToken: leaseToken.safeParse(undefined).success,
  }).toEqual({
    opaqueToken: true,
    emptyToken: true,
    oversizedToken: true,
    omittedToken: true,
  });
});

test("identity 输出 schema 覆盖 REST 的 token / pushContentTier", () => {
  const createOut = toolConfigs.get("mail_new_identity")!.outputSchema!;
  expect(createOut.pushContentTier).toBeDefined();
  expect(createOut.token).toBeDefined();
  expect(createOut.pushContentTier!.safeParse(2).success).toBe(true);
  expect(createOut.pushContentTier!.safeParse(4).success).toBe(false);
  expect(createOut.token!.safeParse("oa_abc").success).toBe(true);

  const listOut = toolConfigs.get("mail_list_identities")!.outputSchema!.identities;
  const row = {
    address: "fox@test.example",
    createdAt: "2026-08-10T00:00:00.000Z",
    pushContentTier: 1 as const,
  };
  expect(listOut!.safeParse([row]).success).toBe(true);
  expect(listOut!.safeParse([{ ...row, address: "bot@localhost" }]).success).toBe(true);
  expect(listOut!.safeParse([{ ...row, address: "bot@example.com." }]).success).toBe(true);
  expect(listOut!.safeParse([{ ...row, address: "not-an-email" }]).success).toBe(false);
});

test("mail_send 输出含可选审计 id，缺省仍通过", () => {
  const sendOut = toolConfigs.get("mail_send")!.outputSchema!;
  expect(sendOut.queued!.safeParse(true).success).toBe(true);
  expect(sendOut.messageId!.safeParse("<m@test.example>").success).toBe(true);
  expect(sendOut.id!.safeParse("snd_abc").success).toBe(true);
  const sendSchema = z.object(sendOut as z.ZodRawShape);
  expect(sendSchema.safeParse({ queued: true, messageId: "<m@test.example>" }).success).toBe(true);
  expect(
    sendSchema.safeParse({ queued: true, messageId: "<m@test.example>", id: "snd_1" }).success,
  ).toBe(true);
});

// 输出 schema 与 API 对齐：list/detail 各用真实类型夹具，互不污染。
test("message summary/detail 输出 schema 按 API 真实形状校验并保留字段", () => {
  const listMessages = toolConfigs.get("mail_list_messages")!.outputSchema!.messages;
  // 显式标注 API MessageSummary——多/少字段都会在类型检查时报错。
  const summary: MessageSummary = {
    id: "42",
    from: "Alice <alice@example.com>",
    to: "Bob <bob@example.com>, Carol <carol@example.com>",
    subject: "hi",
    date: "2026-08-09T00:00:00.000Z",
    seen: false,
    snippet: "body",
    hasOtp: true,
    source: "external",
  };
  const listParsed = listMessages.safeParse([summary]);
  expect(listParsed.success).toBe(true);
  // 缺 source / hasOtp 必须失败——严格客户端靠 advertised schema 认字段，不能当 additional。
  const { source: _source, hasOtp: _hasOtp, ...summaryWithoutSourceOtp } = summary;
  expect(listMessages.safeParse([summaryWithoutSourceOtp]).success).toBe(false);
  expect(listMessages.safeParse([{ ...summaryWithoutSourceOtp, source: "external" }]).success).toBe(
    false,
  );
  expect(listMessages.safeParse([{ ...summaryWithoutSourceOtp, hasOtp: true }]).success).toBe(false);
  if (listParsed.success) {
    const rows = listParsed.data as MessageSummary[];
    expect(rows[0]?.hasOtp).toBe(true);
    expect(rows[0]?.seen).toBe(false);
    expect(rows[0]?.snippet).toBe("body");
    expect(rows[0]?.from).toBe("Alice <alice@example.com>");
    expect(rows[0]?.to).toBe("Bob <bob@example.com>, Carol <carol@example.com>");
  }

  const readOut = toolConfigs.get("mail_read_message")!.outputSchema!;
  // 显式标注 API MessageDetail——不得夹带 seen/snippet/hasOtp。
  const detail: MessageDetail = {
    id: "42",
    from: "Alice <alice@example.com>",
    to: "Bob <bob@example.com>, Carol <carol@example.com>",
    subject: "hi",
    date: "2026-08-09T00:00:00.000Z",
    source: "external",
    text: "plain",
    html: "<p>plain</p>",
    otp: { codes: ["123456"], links: ["https://example.com/otp"] },
    links: ["https://example.com/a", "https://example.com/b"],
    taskId: "task-1",
    taskState: "submitted",
  };
  const detailSchema = z.object(readOut as z.ZodRawShape);
  const detailParsed = detailSchema.safeParse(detail);
  expect(detailParsed.success).toBe(true);
  if (detailParsed.success) {
    // summary-only 字段不得出现在 detail schema / 校验结果里。
    expect("hasOtp" in detailParsed.data).toBe(false);
    expect("seen" in detailParsed.data).toBe(false);
    expect("snippet" in detailParsed.data).toBe(false);
    expect(detailParsed.data.links).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(detailParsed.data.taskId).toBe("task-1");
    expect(detailParsed.data.taskState).toBe("submitted");
  }
  // 可选 task* 缺省放行；detail outputSchema 不得声明 summary-only 字段。
  const { taskId: _tid, taskState: _ts, ...detailWithoutTask } = detail;
  const detailWithoutTaskTyped: MessageDetail = detailWithoutTask;
  expect(detailSchema.safeParse(detailWithoutTaskTyped).success).toBe(true);
  expect(readOut.hasOtp).toBeUndefined();
  expect(readOut.seen).toBeUndefined();
  expect(readOut.snippet).toBeUndefined();

  // 展开后的多收件人 To 可超 998：无界 string，不得再按物理行限拒。
  const longTo = Array.from({ length: 40 }, (_, i) => `User${i} <u${i}@example.com>`).join(", ");
  expect(longTo.length).toBeGreaterThan(998);
  expect(readOut.to!.safeParse(longTo).success).toBe(true);
  expect(readOut.from!.safeParse("x".repeat(2000)).success).toBe(true);

  // task 参与者仍是裸地址校验——不要跟着 message 一起放宽。
  const taskCreate = toolSchemas.get("task_create")!;
  expect(taskCreate.to!.safeParse("Alice <alice@example.com>").success).toBe(false);
  expect(taskCreate.to!.safeParse("alice@example.com").success).toBe(true);
});
