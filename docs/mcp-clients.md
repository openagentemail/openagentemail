# MCP client setup

The MCP server wraps the REST API one-to-one, so your agent gets email as native
tool calls. It runs over **stdio** and needs [Bun](https://bun.sh) on the machine
running the MCP client, plus two environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `OPENAGENTEMAIL_API_URL` | Base URL of the API | `http://localhost:3100` |
| `OPENAGENTEMAIL_API_KEY` | One of the keys from the server's `API_KEYS` env | — (required) |

In the examples below, `/path/to/openagentemail` is wherever you cloned the repo.
From a local checkout the server starts with
`bun run /path/to/openagentemail/packages/mcp/src/main.ts`; once published to npm,
`bunx openagentemail-mcp` works without a checkout. See
[packages/mcp/README.md](../packages/mcp/README.md) for server internals.

## Tools your agent gets

| Tool | What it does |
|---|---|
| `mail_new_identity(name?)` | Create a new address (random localpart like `fox-k7d2` if no name given) |
| `mail_list_identities()` | List all identities |
| `mail_list_messages(address, limit?)` | List an inbox |
| `mail_read_message(address, id)` | Full message with `otp.codes` / `otp.links` extracted |
| `mail_wait_for(address, fromContains?, subjectContains?, timeoutSec?)` | Block until a matching message arrives (default 120s, max 600s) |
| `mail_send(from, to, subject, text, html?)` | Send from an existing identity |

A typical automated-signup flow is: `mail_new_identity` → do the signup with that
address → `mail_wait_for(address, subjectContains="verify")` → open `otp.links[0]`.

## Claude Code

```bash
claude mcp add openagentemail \
  --env OPENAGENTEMAIL_API_URL=http://localhost:3100 \
  --env OPENAGENTEMAIL_API_KEY=your-api-key \
  -- bun run /path/to/openagentemail/packages/mcp/src/main.ts
```

Or edit `~/.claude.json` / project `.mcp.json` directly with the JSON block from
[Generic MCP clients](#generic-mcp-clients) below.

## Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "openagentemail": {
      "command": "bun",
      "args": ["run", "/path/to/openagentemail/packages/mcp/src/main.ts"],
      "env": {
        "OPENAGENTEMAIL_API_URL": "http://localhost:3100",
        "OPENAGENTEMAIL_API_KEY": "your-api-key"
      }
    }
  }
}
```

Restart Claude Desktop after saving. If the server doesn't appear, check
**Settings → Developer** logs — a wrong absolute path to `main.ts` (or missing Bun)
is the usual cause.

## Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "openagentemail": {
      "command": "bun",
      "args": ["run", "/path/to/openagentemail/packages/mcp/src/main.ts"],
      "env": {
        "OPENAGENTEMAIL_API_URL": "http://localhost:3100",
        "OPENAGENTEMAIL_API_KEY": "your-api-key"
      }
    }
  }
}
```

Then toggle the server on in **Settings → MCP**.

## Kimi Code

Edit `~/.kimi-code/mcp.json` (user level) or `.kimi-code/mcp.json` in the project
(project level takes precedence):

```json
{
  "mcpServers": {
    "openagentemail": {
      "command": "bun",
      "args": ["run", "/path/to/openagentemail/packages/mcp/src/main.ts"],
      "env": {
        "OPENAGENTEMAIL_API_URL": "http://localhost:3100",
        "OPENAGENTEMAIL_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or run `/mcp-config` in the TUI to add it interactively; `/mcp` shows connection
status. Tools appear as `mcp__openagentemail__mail_wait_for`, etc.

## Generic MCP clients

Any client that speaks stdio MCP can run the server the same way:

```json
{
  "mcpServers": {
    "openagentemail": {
      "command": "bun",
      "args": ["run", "/path/to/openagentemail/packages/mcp/src/main.ts"],
      "env": {
        "OPENAGENTEMAIL_API_URL": "http://localhost:3100",
        "OPENAGENTEMAIL_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Running against a remote server

The MCP server itself always runs locally (stdio), but `OPENAGENTEMAIL_API_URL` can
point anywhere the API is reachable — e.g. your VPS:

```json
"env": {
  "OPENAGENTEMAIL_API_URL": "https://api.example.com",
  "OPENAGENTEMAIL_API_KEY": "your-api-key"
}
```

The API key is sent as a bearer token, so use HTTPS when the API is off localhost.

## Troubleshooting

- **Server starts but every tool errors with 401** — `OPENAGENTEMAIL_API_KEY` doesn't
  match any key in the API's `API_KEYS` env.
- **Server exits immediately at startup** — `OPENAGENTEMAIL_API_KEY` is missing
  (the server refuses to run without it).
- **Server fails to start** — check Bun is installed and the absolute path to
  `packages/mcp/src/main.ts`; most clients log the child's stderr.
- **`mail_wait_for` returns nothing** — the default timeout is 120s (max 600s).
  Verify inbound mail works with `./deploy/doctor.sh` before blaming the client.
