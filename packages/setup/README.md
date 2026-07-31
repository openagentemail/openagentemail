# @openagentemail/setup

Set up [openagent.email](https://openagent.email) with one guided command:

```sh
npx -y @openagentemail/setup
```

The wizard can connect an existing server, start a local demo, or show VPS and domain recommendations. It never writes an admin key to an MCP client: when you provide an admin key, setup creates a scoped identity token and stores only that token in the selected client configs.

> Screenshot placeholder: connect/demo/recommendation wizard

## Guided setup

Run the command without arguments and answer the prompts. If you leave during the recommendation flow, progress is saved to `~/.config/openagentemail/setup-state.json` (or `$XDG_CONFIG_HOME/openagentemail/setup-state.json`) and the next run offers to continue.

The connect flow:

1. Verifies the server's `/healthz` endpoint.
2. Validates an identity token or turns an admin key into a safer scoped identity token.
3. Detects installed MCP clients and lets you choose which ones to configure.
4. Backs up existing config files, merges the `openagentemail` entry, and writes atomically.

Supported clients: Claude Code, Cursor, Kimi Code, Claude Desktop, Windsurf, Codex CLI, and Gemini CLI.

## Local demo

```sh
npx -y @openagentemail/setup demo
```

The demo requires Docker with the Compose plugin. It clones the server into `~/.local/share/openagentemail/demo`, generates random local credentials, starts the stack with `DOMAIN=demo.local`, creates a `demo-agent` identity, and opens the same MCP-client configuration flow.

Dashboard: `http://localhost:3100/ui`

The local demo cannot receive mail from the public internet. Use it to explore the dashboard and API, then follow the [quickstart](https://openagent.email/docs/quickstart) to deploy on a VPS.

Remove the demo and its volumes:

```sh
npx -y @openagentemail/setup demo --teardown
```

## Non-interactive use

For agents and scripts, pass `--yes --json`. Standard output contains exactly one JSON result; progress and warnings go to standard error. Tokens are never included in output or the resume-state file.

```sh
npx -y @openagentemail/setup connect \
  --api-url https://mail.example.com \
  --token "$OPENAGENTEMAIL_ADMIN_KEY" \
  --clients claude-code,cursor,kimi-code \
  --yes --json
```

Use an identity token directly:

```sh
npx -y @openagentemail/setup connect \
  --api-url http://localhost:3100 \
  --token "$OPENAGENTEMAIL_IDENTITY_TOKEN" \
  --clients codex \
  --yes --json --verify
```

Start or reuse a demo without changing any MCP client config:

```sh
npx -y @openagentemail/setup demo --clients none --yes --json
```

Add `--no-fetch` to use the bundled recommendation list without checking for a newer list. Recommendation links are data-driven and live in `recommendations.json`; the initial package contains owner-supplied placeholders only.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 1 | General input, filesystem, or command error |
| 2 | API server unreachable or `/healthz` invalid |
| 3 | Token invalid |
| 4 | Optional MCP handshake failed |
| 5 | Docker or Docker Compose missing |
| 6 | Demo did not become healthy within 180 seconds |

## Development

```sh
cd packages/setup
bun install
bun test
bunx tsc --noEmit
bun run build
```

The package is bundled into one Node.js entry file and requires Node.js 20 or newer.
