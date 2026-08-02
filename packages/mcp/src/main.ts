#!/usr/bin/env node
/**
 * openagentemail-mcp — MCP server (stdio) wrapping the openagent.email REST API.
 *
 * Env:
 *   OPENAGENTEMAIL_API_URL  base URL of the API (default http://localhost:3100)
 *   OPENAGENTEMAIL_API_KEY  bearer key (required: identity token oa_… or an admin key)
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ApiError, OpenAgentEmailClient, apiUrlForDisplay } from "./lib/client.ts";

// Read our own version from package.json (works from both src/ and dist/):
// hardcoding it here once drifted a full release behind the published package.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const apiUrl = process.env.OPENAGENTEMAIL_API_URL ?? "http://localhost:3100";
const apiKey = process.env.OPENAGENTEMAIL_API_KEY;

if (!apiKey) {
  console.error(
    "openagentemail-mcp: OPENAGENTEMAIL_API_KEY is not set.\n" +
      "Set it to an identity token (oa_…, from POST /v1/identities) or an admin\n" +
    "key from the server's API_KEYS, e.g.:\n" +
      '  OPENAGENTEMAIL_API_KEY=... npx -y @openagentemail/mcp',
  );
  process.exit(1);
}

const client = new OpenAgentEmailClient(apiUrl, apiKey);

const server = new McpServer({
  name: "openagentemail",
  version: pkg.version,
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const mutatingAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const identitySchema = {
  address: z.email(),
  name: z.string().optional(),
  createdAt: z.string().optional(),
  canNotifyUser: z.boolean().optional(),
};

const messageSummarySchema = {
  id: z.string(),
  from: z.email(),
  to: z.email(),
  subject: z.string(),
  date: z.string(),
  seen: z.boolean(),
  snippet: z.string(),
};

const messageOutputSchema = {
  ...messageSummarySchema,
  text: z.string(),
  html: z.string().optional(),
  otp: z.object({
    codes: z.array(z.string()),
    links: z.array(z.string()),
  }),
};

const identityListOutputSchema = {
  identities: z.array(z.object(identitySchema)),
};

const messageListOutputSchema = {
  messages: z.array(z.object(messageSummarySchema)),
};

const receivedMessageInputSchema = {
  address: z.email().describe("Full email address of the identity that received it"),
  // 服务端按 Number(id) 要求正整数 UID。
  id: z
    .string()
    .regex(/^[1-9]\d*$/)
    .describe("Message id from mail_list_messages / mail_wait_for"),
};

const seenOutputSchema = {
  id: z.string(),
  seen: z.boolean(),
};

const sendOutputSchema = {
  queued: z.boolean(),
  messageId: z.string(),
};

const notifyLevelSchema = z.enum(["urgent", "normal", "low"]);

const notifyOutputSchema = {
  target: z.string(),
  title: z.string(),
  level: notifyLevelSchema,
};

const notifyCheckOutputSchema = {
  messages: z.array(z.object({
    id: z.string(),
    time: z.number(),
    title: z.string(),
    message: z.string(),
    priority: z.number(),
    tags: z.array(z.string()),
  })),
};

const notifyVerifyOutputSchema = {
  ok: z.literal(true),
};

function ok(data: unknown): CallToolResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("Tool output must be a JSON object");
  }

  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown): CallToolResult {
  const message =
    err instanceof ApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function callApi(
  operation: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return ok(await operation());
  } catch (err) {
    return fail(err);
  }
}

server.registerTool(
  "mail_new_identity",
  {
    title: "Create Email Identity",
    description:
      "Create a new email identity (mailbox address) on this openagent.email server. Pass 'localpart' for a custom address (e.g. 'qa-bot' gives qa-bot@domain), or omit it for a random one. Returns the full address; the address also gets a scoped API token.",
    inputSchema: {
      // 约束与 REST API 的 zod 对齐：本地就能拒掉的输入不必往服务端跑一趟。
      name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Optional display name for the identity"),
      localpart: z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9._-]{0,62}$/,
          "must start with alphanumeric, then a-z0-9._-, max 63 chars",
        )
        .optional()
        .describe(
          "Custom email localpart (e.g. 'my-bot' for my-bot@domain). If omitted, a random one is generated.",
        ),
      canNotifyUser: z
        .boolean()
        .optional()
        .describe("Admin only: allow this identity to send human-alert notifications"),
    },
    outputSchema: identitySchema,
    annotations: mutatingAnnotations,
  },
  ({ name, localpart, canNotifyUser }) => callApi(() => client.createIdentity({ name, localpart, canNotifyUser })),
);

server.registerTool(
  "mail_list_identities",
  {
    title: "List Email Identities",
    description: "List all email identities (addresses) on this server.",
    outputSchema: identityListOutputSchema,
    annotations: readOnlyAnnotations,
  },
  () => callApi(async () => ({ identities: await client.listIdentities() })),
);

server.registerTool(
  "mail_list_messages",
  {
    title: "List Email Messages",
    description:
      "List messages received by an identity address (newest first), with id/from/to/subject/date/seen/snippet.",
    inputSchema: {
      address: z.email().describe("Full email address of the identity"),
      limit: z
        .number()
        .int()
        .min(1)
        // The API rejects anything above 200 with 400 invalid_request, so the
        // tool schema must not advertise a range the server refuses.
        .max(200)
        .optional()
        .describe("Max messages to return (1-200, server default 50)"),
    },
    outputSchema: messageListOutputSchema,
    annotations: readOnlyAnnotations,
  },
  ({ address, limit }) =>
    callApi(async () => ({ messages: await client.listMessages(address, limit) })),
);

server.registerTool(
  "mail_read_message",
  {
    title: "Read Email Message",
    description:
      "Read a full message: text, html (if any), and extracted OTP verification codes and links.",
    inputSchema: receivedMessageInputSchema,
    outputSchema: messageOutputSchema,
    annotations: readOnlyAnnotations,
  },
  ({ address, id }) => callApi(() => client.readMessage(address, id)),
);

server.registerTool(
  "mail_mark_seen",
  {
    title: "Mark Email Seen",
    description:
      "Mark a message as read (seen=true) or unread (seen=false). Call this after processing a message so the unseen count reflects what is still unhandled. Reading a message never changes this flag by itself.",
    inputSchema: {
      ...receivedMessageInputSchema,
      seen: z
        .boolean()
        .optional()
        .describe("true = mark as read (default), false = mark as unread"),
    },
    outputSchema: seenOutputSchema,
    annotations: {
      ...mutatingAnnotations,
      idempotentHint: true,
    },
  },
  ({ address, id, seen }) =>
    callApi(() => client.markSeen(address, id, seen ?? true)),
);

server.registerTool(
  "mail_wait_for",
  {
    title: "Wait for Email",
    description:
      "Wait for an incoming message matching optional from/subject filters. Returns the full message (with OTP codes/links) or a timeout error.",
    inputSchema: {
      address: z.email().describe("Full email address of the identity to watch"),
      fromContains: z
        .string()
        .max(200)
        .optional()
        .describe("Only match messages whose From contains this substring"),
      subjectContains: z
        .string()
        .max(200)
        .optional()
        .describe("Only match messages whose Subject contains this substring"),
      timeoutSec: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe("Seconds to wait (default 120, max 600)"),
    },
    outputSchema: messageOutputSchema,
    annotations: { ...readOnlyAnnotations, idempotentHint: false },
  },
  ({ address, fromContains, subjectContains, timeoutSec }) =>
    callApi(() =>
      client.waitFor(address, { fromContains, subjectContains, timeoutSec }),
    ),
);

server.registerTool(
  "mail_send",
  {
    title: "Send Email",
    description:
      "Send an email from an existing identity address. 'from' must be an identity created with mail_new_identity.",
    inputSchema: {
      from: z.email().describe("Sender address (must be an existing identity)"),
      to: z.email().describe("Recipient address"),
      subject: z.string().max(998).describe("Subject line"),
      text: z.string().max(1_000_000).describe("Plain-text body"),
      html: z.string().max(1_000_000).optional().describe("Optional HTML body"),
    },
    outputSchema: sendOutputSchema,
    annotations: mutatingAnnotations,
  },
  ({ from, to, subject, text, html }) =>
    callApi(() => client.send(from, to, subject, text, html)),
);

const notificationInputSchema = {
  title: z.string().min(1).max(256).describe("Short notification title"),
  message: z.string().min(1).max(4_000).describe("Notification body"),
  level: notifyLevelSchema.optional().describe("urgent, normal (default), or low"),
  tags: z.array(z.string().min(1).max(64)).max(5).optional().describe("Optional ntfy tags"),
};

server.registerTool(
  "notify_user",
  {
    title: "Notify User",
    description:
      "Send a human-alert notification. Identity tokens need the server-side can_notify_user grant; this tool never needs a topic or ntfy credential.",
    inputSchema: notificationInputSchema,
    outputSchema: notifyOutputSchema,
    annotations: mutatingAnnotations,
  },
  ({ title, message, level, tags }) =>
    callApi(() => client.notifyUser(title, message, level ?? "normal", tags)),
);

server.registerTool(
  "notify_agent",
  {
    title: "Notify Agent",
    description:
      "Wake a named agent through the server-side notification route. The server owns topics and credentials; pass the target agent's identity localpart only.",
    inputSchema: {
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/)
        .describe("Target agent identity localpart, for example qa-bot"),
      ...notificationInputSchema,
    },
    outputSchema: notifyOutputSchema,
    annotations: mutatingAnnotations,
  },
  ({ name, title, message, level, tags }) =>
    callApi(() => client.notifyAgent(name, title, message, level ?? "normal", tags)),
);

server.registerTool(
  "notify_check",
  {
    title: "Check Agent Notifications",
    description:
      "Read recent notifications for this identity only. The server maps the token to its own topic, so no topic name or ntfy credential is exposed.",
    inputSchema: {
      since: z.string().min(1).max(64).optional().describe("Optional ntfy duration or timestamp filter"),
    },
    outputSchema: notifyCheckOutputSchema,
    annotations: readOnlyAnnotations,
  },
  ({ since }) => callApi(async () => ({ messages: await client.notificationCheck(since) })),
);

server.registerTool(
  "notify_verify",
  {
    title: "Verify Notification Delivery",
    description:
      "Send a harmless server-side notification check and poll it back. Requires the same human-alert permission as notify_user.",
    outputSchema: notifyVerifyOutputSchema,
    annotations: mutatingAnnotations,
  },
  () => callApi(() => client.verifyNotifications()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`openagentemail-mcp connected (api: ${apiUrlForDisplay(apiUrl)})`);
