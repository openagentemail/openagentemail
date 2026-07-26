# Deliverability field guide

Sending mail that actually lands in the inbox is the hard part of self-hosting.
This guide is the short version of what usually goes wrong, in the order you should
check it. `deploy/doctor.sh` automates most of these checks — run it first.

## 1. Port 25 — is it even open?

Many VPS providers block outbound TCP 25 by default to deter spam:

- **Blocked by default:** AWS EC2/Lightsail (throttled + block, request removal via
  support form), Google Cloud (fully blocked, no exceptions), Azure (blocked on most
  subscriptions), DigitalOcean (blocked on new accounts; open a ticket), Oracle Cloud
  (blocked).
- **Usually open:** Hetzner (blocked the first month / until first paid invoice,
  then openable via ticket), Vultr (openable via ticket), OVH, Linode/Akamai
  (openable via ticket), most smaller hosts.

Inbound 25 matters just as much — without it you receive nothing.

**Test both directions:**

```bash
# outbound: can you reach someone else's MX?
nc -vz gmail-smtp-in.l.google.com 25

# inbound: can the world reach you?
# (from another machine)
nc -vz mail.example.com 25
```

If outbound 25 is blocked and can't be unblocked, you must relay (see §4).

## 2. PTR / rDNS must match HELO

docker-mailserver introduces itself with its hostname — `mail.example.com`. Receivers
check that the connecting IP's PTR record returns the same name, and that the name
resolves back to the same IP (FCrDNS). Fail this and Outlook/Hotmail will reject or
bulk-folder nearly everything.

- Set PTR at your **hosting provider's panel**, not your DNS registrar.
- It must say `mail.example.com`, not the apex and not the provider default.
- Details in [dns-setup.md](dns-setup.md#6-ptr-rdns--your-vps-ip--mailexamplecom).

## 3. IP reputation — new IPs start cold

A fresh VPS IP has *no* reputation, and some providers (Outlook especially) treat
"unknown" as "suspicious". Worse, the IP may inherit a bad reputation from a
previous tenant.

- Check your IP against the major DNSBLs before you build on it:
  [mxtoolbox.com/blacklists.aspx](https://mxtoolbox.com/blacklists.aspx). If it's
  listed at Spamhaus, either delist or ask your provider for a different IP —
  fighting someone else's spam history is not worth it.
- **Warm up:** for the first 1–2 weeks, keep volume low and send only to engaged
  recipients. A brand-new IP that suddenly sends hundreds of sign-up confirmations
  a day is textbook spammer behavior.
- Keep bounce rates low — `mail_send` to addresses that hard-bounce is the fastest
  way onto a blocklist.

## 4. Relaying through SES / SMTP2GO / any SMTP relay

If port 25 is blocked, or you don't want to manage IP reputation at all, route
outbound through a relay. Inbound still arrives directly at your catch-all — only
sending changes.

Set `RELAY_HOST` (plus `RELAY_PORT` / `RELAY_USER` / `RELAY_PASSWORD` /
`DEFAULT_RELAY_HOST`) in `.env`; outbound mail then goes through the relay instead
of the VPS's own SMTP. `.env.example` has a filled-in Amazon SES example. Inbound
is unaffected — mail still arrives directly at your catch-all.

**Amazon SES notes:**

- New SES accounts start in **sandbox mode**: you can only send to verified
  addresses. Request production access (a short form describing your use case)
  before pointing agents at it.
- Verify your domain in SES and enable **Easy DKIM**; keep the SES `include:` in
  your SPF record (`v=spf1 mx include:amazonses.com ~all`). Without SES's DKIM,
  DMARC alignment still passes via SPF, but DKIM is the stronger signal.
- When relaying, your VPS IP reputation stops mattering for outbound — the relay's
  IPs are what receivers see. Your DNS records (SPF/DKIM/DMARC) still must be correct.

## 5. DKIM / SPF / DMARC alignment

The full record-by-record walkthrough is in [dns-setup.md](dns-setup.md). The
deliverability-relevant summary:

- **SPF** must list every source that sends for your domain (your MX, plus any relay).
  Exactly one `v=spf1` record.
- **DKIM** must be published from the key in the mailserver volume, and receivers
  must see `dkim=pass` with `d=example.com` — the same domain as the visible `From:`.
- **DMARC** passes when SPF *or* DKIM passes **and** aligns with the `From:` domain.
  Since every identity sends as `something@example.com`, alignment is automatic as
  long as you don't rewrite the domain elsewhere.
- Verify by sending to a Gmail address and inspecting "Show original" — you want
  `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS` on one line each.

## 6. Monitoring

- **Google Postmaster Tools** — [postmaster.google.com](https://postmaster.google.com):
  add your domain for reputation, spam-rate, and auth-failure dashboards. Free, and
  the closest thing to ground truth for Gmail.
- **Microsoft SNDS** — [sendersupport.olc.protection.outlook.com/snds](https://sendersupport.olc.protection.outlook.com/snds):
  per-IP view of what Outlook thinks of you.
- **`deploy/doctor.sh`** — local end-to-end check: DNS records, TLS certs, IMAP/SMTP
  login, and a real round-trip message through the stack. Run it after any config
  change and on a cron if you're paranoid.
- **Mail-tester** — [mail-tester.com](https://www.mail-tester.com): send to the
  address it gives you, get a spam-score breakdown of exactly what receivers see.

## 7. Spam-score pitfalls specific to this setup

- **Public resolvers break DNSBL checks.** SpamAssassin and Rspamd (inside
  docker-mailserver) query DNS blocklists over DNS. Public resolvers (8.8.8.8,
  1.1.1.1) are rate-limited/refused by the major DNSBLs, which makes every lookup
  time out — silently disabling inbound spam filtering or, worse, flipping some
  rules to false positives. **Run a local resolver** (unbound/dnsmasq on the VPS, or
  Docker's embedded resolver as configured in the compose file) and don't point the
  mail container at a public anycast resolver.
- **New-TLD heuristics.** Some filters score cheap/new TLDs (`.xyz`, `.top`, and to a
  lesser degree `.email`) higher by default because spammers love them. A `.com`/`.net`/`.io`
  domain with clean history outperforms a $1 TLD. If you must use a new TLD, correct
  SPF/DKIM/DMARC + low volume + warm-up matter even more.
- **Don't spoof other domains** from your identities — ever. Sending as
  `anything@notyourdomain.com` fails alignment by definition and torches your
  reputation.
- **Identical high-volume content** (the same confirmation email 500×/hour) trips
  bulk-content heuristics. Vary subjects slightly if your use case allows it.
