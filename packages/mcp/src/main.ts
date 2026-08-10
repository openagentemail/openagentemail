#!/usr/bin/env node
/**
 * openagentemail-mcp — stdio 入口（工具实现见 packages/api/src/mcp/）。
 *
 * Env:
 *   OPENAGENTEMAIL_API_URL  API 基址（默认 http://localhost:3100）
 *   OPENAGENTEMAIL_API_KEY  Bearer（oa_… 或 admin key，必填）
 */
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
// 共享实现物理位置在 api（Docker 只 COPY packages/api）；stdio 构建会打包进 dist。
import {
  OpenAgentEmailClient,
  apiUrlForDisplay,
} from "../../api/src/mcp/client.ts";
import { registerOpenAgentEmailTools } from "../../api/src/mcp/tools.ts";

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
      "  OPENAGENTEMAIL_API_KEY=... npx -y @openagentemail/mcp",
  );
  process.exit(1);
}

const client = new OpenAgentEmailClient(apiUrl, apiKey);
const server = new McpServer({
  name: "openagentemail",
  version: pkg.version,
});
registerOpenAgentEmailTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`openagentemail-mcp connected (api: ${apiUrlForDisplay(apiUrl)})`);
