# Security Policy

openagent.email is a self-hosted mail product. We take security reports seriously —
a mailbox holds credentials, OTP codes, and agent tokens by design.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Email **hi@openagent.email** with:

- what you found and how to reproduce it,
- the affected component (API, MCP server, setup CLI, dashboard, compose stack),
- the version or commit you tested against.

You will get a human acknowledgment within 48 hours. We aim to ship a fix or a
documented mitigation within 7 days for critical issues, and we will credit you
in the release notes unless you prefer otherwise.

## Supported versions

We support the latest released version only. Fixes land on `main` and ship in the
next release; we do not maintain backport branches yet.

| Component | Supported |
|---|---|
| `@openagentemail/mcp` | latest release |
| `@openagentemail/setup` | latest release |
| Self-hosted API + compose stack | latest `main` |

## Scope notes

- Report bugs in **our** code (API, MCP, setup CLI, dashboard, deploy scripts).
  Vulnerabilities in upstream dependencies (docker-mailserver, ntfy, Hono) should
  go to those projects — but tell us too if our default configuration makes them
  exploitable.
- Issues that require an attacker to already hold an admin key or a mailbox
  password are out of scope (that is the trust boundary by design).
- Please do not run automated scanners against our public website or the hosted
  demo infrastructure without asking first.

## Hall of fame

Security reporters who wish to be credited will be listed here.
