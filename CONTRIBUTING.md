# Contributing

Thanks for your interest. The project is Apache-2.0; by contributing you agree your
work is licensed under the same terms.

## Layout

- `docker-compose.yml`, `.env.example`, `deploy/` — the deployment stack
  (docker-mailserver + API), DNS wizard, and doctor script
- `packages/api` — the REST API (IMAP/SMTP bridge to the catch-all mailbox)
- `packages/mcp` — the MCP server wrapping the REST API
- `docs/` — user-facing documentation

## Development

1. Clone, `cp .env.example .env`, set `DOMAIN` to a throwaway domain you own.
2. `docker compose up -d`, then `./deploy/doctor.sh` to confirm the stack is healthy.
3. Work in `packages/api` or `packages/mcp`; both are plain Node/Bun packages with
   their own READMEs.

## Rules of thumb

- Keep the REST contract and the MCP tool surface in sync — every REST operation
  has a `mail_*` tool and vice versa.
- No new runtime dependencies outside Docker containers; the whole stack must stay
  `docker compose up -d`-able.
- Docs changes go in the same PR as behavior changes.

Open an issue before large changes. Small fixes (typos, docs, bugs with a repro)
can go straight to a PR.
