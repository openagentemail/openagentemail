# DNS setup

`deploy/dns-records.sh` prints the exact records below with your real values filled
in. This page explains what each one does, why it exists, and the mistakes that
break it. Everything here assumes `DOMAIN=example.com` and the mail hostname
`mail.example.com` — substitute yours.

Set these records **before** expecting inbound mail, and re-check them any time with
`./deploy/doctor.sh`.

## The records

### 1. `A` / `AAAA` — `mail.example.com` → your VPS IP

```
mail.example.com.   A      <your VPS IPv4>
mail.example.com.   AAAA   <your VPS IPv6>   # only if the VPS has working IPv6
```

This is how other mail servers find yours. It is also the hostname docker-mailserver
uses as its HELO/EHLO identity, so the name matters beyond simple reachability.

**Common mistakes:**

- **Do not add an AAAA record unless IPv6 actually works end to end** (Docker IPv6
  is often not configured). Gmail will happily try IPv6 first and defer or reject
  when it times out.
- **Cloudflare users: this record must be "DNS only" (grey cloud).** If the orange
  proxy cloud is on, Cloudflare terminates the connection and SMTP on ports
  25/465/587 never reaches your VPS. The mail hostname must **never** be proxied.
  (This applies to the `mail.` hostname only — proxying your web hostname is fine.)

### 2. `MX` — `example.com` → `mail.example.com`

```
example.com.        MX     10 mail.example.com.
```

Tells the world "mail for `*@example.com` goes to `mail.example.com`". The priority
(`10`) is arbitrary when you have a single MX.

**Common mistakes:**

- Pointing the MX at the apex (`example.com`) when the A record lives on `mail.` —
  it works only if the apex A record is the same IP and not proxied.
- Pointing the MX at a CNAME. [RFC 2181 §10.3](https://www.rfc-editor.org/rfc/rfc2181#section-10.3)
  forbids it; some senders reject, others silently defer.

### 3. `SPF` (TXT) — who may send for the domain

```
example.com.        TXT    "v=spf1 mx ~all"
```

Declares that the host(s) in your MX record may send mail for `example.com`.
`~all` (softfail) is the pragmatic choice while you're tuning; tighten to `-all`
once everything is verified.

**Common mistakes:**

- **More than one `v=spf1` TXT record.** Having two makes SPF fail with `permerror`
  everywhere. Merge into a single record, e.g.
  `"v=spf1 mx include:amazonses.com ~all"` when relaying through SES.
- Exceeding the 10-DNS-lookup limit with stacked `include:`s — same `permerror` result.

### 4. `DKIM` (TXT) — cryptographic signature

```
mail._domainkey.example.com.   TXT   "v=DKIM1; k=rsa; p=<long base64 key>"
```

docker-mailserver signs every outbound message; receivers verify against this public
key. The record is long — `dns-records.sh` prints it exactly as it must be pasted,
taken from the key docker-mailserver generated on first boot.

**Common mistakes:**

- Splitting/quoting the record incorrectly at the registrar. Many UIs want the value
  as **one line without the inner quotes**; others want 255-char chunks. Follow your
  provider's convention, then verify with `dig TXT mail._domainkey.example.com` —
  the answer must reconstruct to exactly the printed value.
- Rotating the container volume and forgetting the DKIM key changed. The key lives in
  the mailserver data volume; wipe the volume → publish the new key.

### 5. `DMARC` (TXT) — policy + reporting

```
_dmarc.example.com.   TXT   "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"
```

Tells receivers what to do when SPF *and* DKIM both fail, and where to send
aggregate reports. Start with `p=quarantine` (or `p=none` for the first week if you
want pure observation), move to `p=reject` once `doctor.sh` is green.

**Common mistakes:**

- Setting `p=reject` on day one before DKIM/SPF are verified — your own outbound
  mail gets dropped.
- Forgetting that DMARC passes on *alignment*, not just SPF/DKIM existence: the
  domain in the visible `From:` must match the domain that passed SPF/DKIM. Since
  all identities share your one domain, this is automatic here — but it breaks the
  moment you relay through a provider without enabling their DKIM signing.

### 6. `PTR` (rDNS) — your VPS IP → `mail.example.com`

This one is **not set at your registrar** — it is set at your hosting provider
(Hetzner / DigitalOcean / Vultr / AWS console …), whoever owns the IP block.

```
<VPS IPv4>   PTR   mail.example.com.
```

The PTR hostname must match the HELO hostname (`mail.example.com`), and that name
must resolve back to the same IP ("forward-confirmed rDNS"). Many receivers —
especially Microsoft — bulk-folder or reject mail from IPs that fail this check.

**Common mistakes:**

- Leaving the provider default (`123-45-67-89.static.example.net`).
- Setting PTR to the apex domain instead of the mail hostname.
- Forgetting IPv6 PTR if you publish AAAA.

## Checklist

```bash
dig +short A      mail.example.com          # → your VPS IP
dig +short MX     example.com               # → 10 mail.example.com.
dig +short TXT    example.com               # → one v=spf1 record
dig +short TXT    mail._domainkey.example.com
dig +short TXT    _dmarc.example.com
dig +short -x     <VPS IP>                  # → mail.example.com.
```

or just run `./deploy/doctor.sh`, which checks all of the above plus TLS, IMAP/SMTP
login, and a live round-trip.

## Registrar-agnostic how-to

Every DNS provider has the same three fields: **type**, **name/host**, **value**.

- Enter `mail` (not `mail.example.com`) where the UI asks for the host of the A record —
  most providers append the zone automatically.
- For MX/SPF/DMARC at the apex, the host is `@` (or blank, or `example.com.`, depending
  on the UI).
- TTL: anything; 300–3600s is typical. Lower it to 300 while you're iterating.
- Changes are usually visible in minutes; allow up to an hour before concluding
  something is wrong, and always check with `dig` against a public resolver
  (`dig @1.1.1.1 …`) rather than trusting the provider's preview.

## Cloudflare API shortcut

If your zone is on Cloudflare, you can create all records non-interactively:

```bash
export CF_TOKEN=<api token with Zone.DNS edit>   # https://dash.cloudflare.com/profile/api-tokens
export CF_ZONE=<zone ID>                          # Overview page → right sidebar

cf_add() { # type name value [extra json]
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/dns_records" \
    -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
    --data "$1" | jq -r '.success'
}

cf_add '{"type":"A","name":"mail","content":"<VPS IP>","proxied":false,"ttl":300}'
cf_add '{"type":"MX","name":"@","content":"mail.example.com","priority":10,"ttl":300}'
cf_add '{"type":"TXT","name":"@","content":"v=spf1 mx ~all","ttl":300}'
# copy the DKIM value exactly as printed by ./deploy/dns-records.sh:
cf_add '{"type":"TXT","name":"mail._domainkey","content":"<v=DKIM1; k=rsa; p=...>","ttl":300}'
cf_add '{"type":"TXT","name":"_dmarc","content":"v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com","ttl":300}'
```

Two things the API will not save you from:

- `"proxied":false` on the `mail` A record is mandatory — the grey cloud. If you ever
  toggle it orange in the dashboard, inbound SMTP dies silently.
- PTR is still set at your hosting provider, not Cloudflare.
