#!/usr/bin/env node
/**
 * openagentemail-mcp — MCP server (stdio) wrapping the openagent.email REST API.
 *
 * Env:
 *   OPENAGENTEMAIL_API_URL  base URL of the API (default http://localhost:3100)
 *   OPENAGENTEMAIL_API_KEY  bearer key (required: identity token oa_… or an admin key)
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof ApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

server.tool(
  "mail_new_identity",
  "Create a new email identity (mailbox address) on this openagent.email server. Returns the full address; a random localpart like 'fox-k7d2' is generated.",
  {
    // 约束与 REST API 的 zod 对齐：本地就能拒掉的输入不必往服务端跑一趟。
    name: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Optional display name for the identity"),
  },
  async ({ name }) => {
    try {
      return ok(await client.createIdentity(name));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "mail_list_identities",
  "List all email identities (addresses) on this server.",
  {},
  async () => {
    try {
      return ok({ identities: await client.listIdentities() });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "mail_list_messages",
  "List messages received by an identity address (newest first), with id/from/to/subject/date/seen/snippet.",
  {
    address: z.string().email().describe("Full email address of the identity"),
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
  async ({ address, limit }) => {
    try {
      return ok({ messages: await client.listMessages(address, limit) });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "mail_read_message",
  "Read a full message: text, html (if any), and extracted OTP verification codes and links.",
  {
    address: z
      .string()
      .email()
      .describe("Full email address of the identity that received it"),
    // 服务端按 Number(id) 要求正整数 UID。
    id: z
      .string()
      .regex(/^[1-9]\d*$/)
      .describe("Message id from mail_list_messages / mail_wait_for"),
  },
  async ({ address, id }) => {
    try {
      return ok(await client.readMessage(address, id));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "mail_mark_seen",
  "Mark a message as read (seen=true) or unread (seen=false). Call this after processing a message so the unseen count reflects what is still unhandled. Reading a message never changes this flag by itself.",
  {
    address: z
      .string()
      .email()
      .describe("Full email address of the identity that received it"),
    id: z
      .string()
      .regex(/^[1-9]\d*$/)
      .describe("Message id from mail_list_messages / mail_wait_for"),
    seen: z
      .boolean()
      .optional()
      .describe("true = mark as read (default), false = mark as unread"),
  },
  async ({ address, id, seen }) => {
    try {
      return ok(await client.markSeen(address, id, seen ?? true));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "mail_wait_for",
  "Wait for an incoming message matching optional from/subject filters. Returns the full message (with OTP codes/links) or a timeout error.",
  {
    address: z.string().email().describe("Full email address of the identity to watch"),
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
  async ({ address, fromContains, subjectContains, timeoutSec }) => {
    try {
      return ok(
        await client.waitFor(address, { fromContains, subjectContains, timeoutSec }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "mail_send",
  "Send an email from an existing identity address. 'from' must be an identity created with mail_new_identity.",
  {
    from: z.string().email().describe("Sender address (must be an existing identity)"),
    to: z.string().email().describe("Recipient address"),
    subject: z.string().max(998).describe("Subject line"),
    text: z.string().max(1_000_000).describe("Plain-text body"),
    html: z.string().max(1_000_000).optional().describe("Optional HTML body"),
  },
  async ({ from, to, subject, text, html }) => {
    try {
      return ok(await client.send(from, to, subject, text, html));
    } catch (err) {
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`openagentemail-mcp connected (api: ${apiUrlForDisplay(apiUrl)})`);
