# Security guide

**Moved:** this document now lives at https://openagent.email/docs/guides/security/

The website docs are canonical — edit them in the [website repo](https://github.com/openagentemail/website) (`src/content/docs/docs/`).

## Operational caution: do not reuse a deleted identity's localpart

`DELETE /v1/identities/<address>` removes the identity record only. The mail
it received stays in the shared catch-all mailbox until the retention sweeper
removes it (`RETENTION_DAYS`, 30 days by default), and messages are matched to
identities by address alone.

So if you delete `fox-k7d2@your.domain` and then create an identity with the
same localpart, the new token can read the previous holder's mail — including
verification codes and magic links that were never consumed. **Pick a fresh
localpart instead** (the generated random ones never collide), or wait out the
retention window before reusing one.

<!-- Canonical copy lives in the website repo (src/content/docs/docs/); mirror
     this note there when publishing. -->
