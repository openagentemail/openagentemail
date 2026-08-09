# Contributing

Thanks for your interest. The project is Apache-2.0; by contributing you agree your
work is licensed under the same terms.

## Layout

- `docker-compose.yml`, `.env.example`, `deploy/` — the deployment stack
  (docker-mailserver + API), DNS wizard, and doctor script
- `packages/api` — the REST API (IMAP/SMTP bridge to the catch-all mailbox)
- `packages/mcp` — the MCP server wrapping the REST API
- `packages/setup` — the `npx @openagentemail/setup` onboarding CLI
- Website and docs live in a separate repo: `openagentemail/website`

## Development

1. Clone, `cp .env.example .env`, set `DOMAIN` to a throwaway domain you own.
2. `docker compose up -d`, then `./deploy/doctor.sh` to confirm the stack is healthy.
3. Work in `packages/api`, `packages/mcp`, or `packages/setup`; each is a plain
   Node/Bun package with its own README.

### Tests

All tests must pass before a PR is considered:

```bash
cd packages/api   && npx -y bun test
cd packages/mcp   && npx -y bun test && npx -y bun run build
cd packages/setup && npx -y bun test && npx -y bun run build
```

Add or update tests for behavior changes. If the change touches the compose stack,
run a clean-stack acceptance check (see `packages/api/dev/` for examples).

## Rules of thumb

- Keep the REST contract and the MCP tool surface in sync — every REST operation
  has a `mail_*` tool and vice versa.
- No new runtime dependencies outside Docker containers; the whole stack must stay
  `docker compose up -d`-able.
- Docs changes go in the same PR as behavior changes.
- Scope stays focused: no unrelated cleanup or drive-by reformatting.

## How we review (including AI-assisted contributions)

Maintainers and agents alike follow the same bar:

1. **Independent review before merge.** Non-trivial changes get a review pass from
   someone (or some agent) other than the author. For agent-written code we require
   an independently spawned review agent — self-review does not count.
2. **CI must be green.** The `test` workflow runs the full suite on every PR.
3. **Sensitive paths need maintainer sign-off**: authentication, token handling,
   `.github/workflows/`, and release configuration.
4. **Security issues are not PRs.** See [SECURITY.md](SECURITY.md).

Open an issue before large changes. Small fixes (typos, docs, bugs with a repro)
can go straight to a PR.

## External pull requests

What to expect when you open a PR from a fork:

- **First response within 48 hours.** We triage every external PR — real bug /
  conflict with main / scope question — and leave a comment so you know someone
  is on it.
- **Same merge bar as maintainers**: green CI, CodeRabbit success, all review
  threads resolved, and a maintainer's final review. CI on fork PRs runs only
  after a maintainer approves it (a GitHub safeguard, not a judgment on you).
- **Conflicts with main**: for a small, aging PR we may take it over — land the
  fix on a maintainer branch with you credited via `Co-authored-by`, thank you
  in your PR, and close it as superseded. Larger or directional changes are
  better rebased by you (or discussed in an issue first).
- **Stale PRs**: after a ping with no response for 14 days we may close the PR
  (you can always reopen it).
- **AI-authored PRs** are held to the same bar as human ones; our review chain
  (bots + maintainer review) provides the independent review, so you do not
  need to arrange your own.
