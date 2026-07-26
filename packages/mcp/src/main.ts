#!/usr/bin/env bun
/**
 * openagentemail-mcp — MCP server (stdio) wrapping the openagent.email REST API.
 *
 * Env:
 *   OPENAGENTEMAIL_API_URL  base URL of the API (default http://localhost:3100)
 *   OPENAGENTEMAIL_API_KEY  bearer key (required; must match server API_KEYS)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiError, OpenAgentEmailClient } from "./lib/client.ts";

const apiUrl = process.env.OPENAGENTEMAIL_API_URL ?? "http://localhost:3100";
const apiKey = process.env.OPENAGENTEMAIL_API_KEY;

if (!apiKey) {
  console.error(
    "openagentemail-mcp: OPENAGENTEMAIL_API_KEY is not set.\n" +
      "Set it to one of the API_KEYS configured on your openagent.email server, e.g.:\n" +
      '  OPENAGENTEMAIL_API_KEY=... bunx openagentemail-mcp',
  );
  process.exit(1);
}

const client = new OpenAgentEmailClient(apiUrl, apiKey);

const server = new McpServer({
  name: "openagentemail",
  version: "0.1.0",
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
  { name: z.string().optional().describe("Optional display name for the identity") },
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
    address: z.string().describe("Full email address of the identity"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Max messages to return (server default 50)"),
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
    address: z.string().describe("Full email address of the identity that received it"),
    id: z.string().describe("Message id from mail_list_messages / mail_wait_for"),
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
  "mail_wait_for",
  "Wait for an incoming message matching optional from/subject filters. Returns the full message (with OTP codes/links) or a timeout error.",
  {
    address: z.string().describe("Full email address of the identity to watch"),
    fromContains: z
      .string()
      .optional()
      .describe("Only match messages whose From contains this substring"),
    subjectContains: z
      .string()
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
    from: z.string().describe("Sender address (must be an existing identity)"),
    to: z.string().describe("Recipient address"),
    subject: z.string().describe("Subject line"),
    text: z.string().describe("Plain-text body"),
    html: z.string().optional().describe("Optional HTML body"),
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
console.error(`openagentemail-mcp connected (api: ${apiUrl})`);
