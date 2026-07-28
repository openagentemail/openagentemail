# @openagentemail/mcp

MCP server (stdio transport) for [openagent.email](https://openagent.email) — gives your AI agent unlimited mailboxes on your own domain: create identities, read/wait for mail, extract OTP codes & verification links, and send email. It wraps the openagent.email REST API over MCP so any MCP-capable client can use it.

## Configuration

The server is configured entirely via environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAGENTEMAIL_API_URL` | no | `http://localhost:3100` | Base URL of the openagent.email API |
| `OPENAGENTEMAIL_API_KEY` | **yes** | — | Bearer key. Best: the identity token (`oa_…`) returned by `POST /v1/identities`. An admin key from the server's `API_KEYS` also works, but grants full access — avoid handing those to agents. |

If `OPENAGENTEMAIL_API_KEY` is missing the server exits immediately with a clear error.

## Tools

| Tool | Description |
| --- | --- |
| `mail_new_identity(name?)` | Create an identity; returns `{address}` (random localpart like `fox-k7d2`) |
| `mail_list_identities()` | List all identities |
| `mail_list_messages(address, limit?)` | List messages for an address (id/from/to/subject/date/seen/snippet) |
| `mail_read_message(address, id)` | Full message: text, html?, and `otp:{codes:[],links:[]}` |
| `mail_mark_seen(address, id, seen?)` | Mark a message read (default) or unread — reading never changes the flag by itself |
| `mail_wait_for(address, fromContains?, subjectContains?, timeoutSec?)` | Block until a matching message arrives (default 120s, max 600s) |
| `mail_send(from, to, subject, text, html?)` | Send mail; `from` must be an existing identity |

Errors come back as `isError` tool results with actionable messages (a 401 tells you to check `OPENAGENTEMAIL_API_KEY`; a 403 means the token's scope doesn't cover what you asked for — identity tokens only touch their own address, and identity management is admin-only; a 429 means the per-identity send rate limit kicked in).

## Client setup

Requires Node.js 18 or newer on the machine running the MCP client — no install step, `npx` downloads and runs the package on first use.

### Claude Code

```sh
claude mcp add openagentemail \
  --env OPENAGENTEMAIL_API_URL=http://localhost:3100 \
  --env OPENAGENTEMAIL_API_KEY=<your-api-key> \
  -- npx -y @openagentemail/mcp
```

Or run from a local checkout: replace `npx -y @openagentemail/mcp` with `bun run /path/to/openagentemail/packages/mcp/src/main.ts`.

### Claude Desktop / Cursor

Add to `claude_desktop_config.json` (Claude Desktop) or `~/.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "openagentemail": {
      "command": "npx",
      "args": ["-y", "@openagentemail/mcp"],
      "env": {
        "OPENAGENTEMAIL_API_URL": "http://localhost:3100",
        "OPENAGENTEMAIL_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

For a local checkout, use `"command": "bun"` and `"args": ["run", "/path/to/openagentemail/packages/mcp/src/main.ts"]` instead.

### Kimi Code

Add to `~/.kimi-code/mcp.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "openagentemail": {
      "command": "npx",
      "args": ["-y", "@openagentemail/mcp"],
      "env": {
        "OPENAGENTEMAIL_API_URL": "http://localhost:3100",
        "OPENAGENTEMAIL_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

Or, from a local checkout, use `"command": "bun"` and `"args": ["run", "/path/to/openagentemail/packages/mcp/src/main.ts"]` instead.

## Development

```sh
cd packages/mcp
bun install
OPENAGENTEMAIL_API_KEY=dev-key bun run src/main.ts   # stdio; speaks JSON-RPC on stdin/stdout
```

The server connects to the API lazily — it starts fine even if the API isn't up yet, and reports a connection error on the first tool call if not.
