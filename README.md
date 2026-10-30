# ratmail

A webmail client that looks and behaves like the **OX App Suite** mail app, built to run on **Cloudflare Workers**. Mail only: no calendar, contacts or drive.

It signs in against your own mail server (IMAP + SMTP), so it works with Mailcow or any other standard mail server. You can offer several servers in a dropdown on the sign-in page.

## What it does

- Sign-in page with a mail server picker and "Stay signed in"
- Folder tree with unread counts, special folders (Inbox, Drafts, Sent, Spam, Trash, Archive) and "My folders" (create, rename, delete, empty, mark all read, drag messages onto folders)
- Message list with infinite scroll, newest first, multi-select (Ctrl/Shift click, checkboxes), keyboard navigation
- Three layouts: **vertical**, **horizontal**, **list**; three list styles: contact pictures, checkboxes, simple
- Reading pane: sanitised HTML in a sandboxed frame, external images blocked with **Show images** / **Always show images from…**, attachments with download, print, show source, save as .eml
- Compose window: floating, minimise / maximise, rich text toolbar, plain text mode, To/CC/BCC/Reply-To as tokens with suggestions, attachments (button or drag and drop), inline images, priority, read receipt, signature, **drafts autosave**, the OX "external images" prompt when replying
- Reply, reply all, forward (with attachments), edit drafts, send as new
- Search (everything / from / to / subject / text, unread, flagged, attachments)
- Settings: accent colours, backgrounds (white, smoke, solarized, dark, sunsets, unicolour), layout, refresh interval, desktop notifications, signed-in devices, extra From addresses, reading and compose options
- Works on phones (single pane with a back button)

## How it works

```
Browser  ──HTTPS──>  Worker (/api/*)  ──IMAP over TLS (993)──>  Mail server
                         │            ──SMTP over TLS (465/587)─>
                         └── D1: sessions + UI preferences only
```

- **No mail is stored.** Every request opens an IMAP connection with `cloudflare:sockets`, does its work and logs out. Sending uses SMTP submission and then saves a copy to Sent.
- **No secrets in the Worker.** At sign-in the Worker checks the password by logging in to IMAP. It then encrypts the password (AES-GCM) with a new random key. The encrypted password goes into D1, and the key goes only into the browser's `HttpOnly; Secure; SameSite=Strict` cookie. Neither the database nor the cookie alone can reveal the password. Signing out deletes the row.
- **D1 holds two small tables** (`schema.sql`): `sessions` and `prefs` (theme, layout, signature, trusted image senders, recent recipients) so settings follow you between devices.
- **Email HTML is made safe twice:** scripts, event handlers, forms and external resources are stripped with `HTMLRewriter`, and the result is shown in a sandboxed iframe (no scripts) with a strict Content-Security-Policy.
- Attachments that could run code on this site (HTML, SVG, etc.) are always downloaded, never shown inline.
- State-changing API calls need an `x-ratmail` header, so other sites cannot forge them.

The frontend is plain HTML, CSS and JavaScript modules in `public/` (no build step). The Worker is in `src/`.

| File | Purpose |
| --- | --- |
| `src/worker.js` | API routes |
| `src/imap.js`, `src/imap-parse.js` | IMAP client and response parser |
| `src/smtp.js` | SMTP submission client |
| `src/mime.js` | Builds outgoing messages |
| `src/sanitize.js` | HTML sanitiser |
| `src/session.js` | Split-key sessions and preferences in D1 |
| `config/servers.json` | Mail servers and branding |

## Configure mail servers

Edit `config/servers.json`:

```json
{
  "brand": { "logo": { "bold": "rat", "light": "mail", "icon": "mail" }, "title": "ratmail", "footer": "© 2026 Josh Douch" },
  "servers": [
    {
      "id": "ratlan",
      "name": "RatLAN (Mailcow)",
      "imap": { "host": "mail.ratlan.net", "port": 993, "tls": "on" },
      "smtp": { "host": "mail.ratlan.net", "port": 465, "tls": "on" }
    }
  ]
}
```

- `tls`: `"on"` (implicit TLS, ports 993/465), `"starttls"` (ports 143/587) or `"off"` (local testing only).
- The first server is the default. With one server the dropdown is hidden.
- Optional `"domain"` on a server: appended to usernames that have no `@` to make the sender address.
- `brand.logo` can also be a plain string like `"ratlan.net"` (terminal icon, split at the dot).
- Optional brand keys: `logoUrl` (an image instead of the text logo), `privacyUrl`, `imprintUrl`.
- You can also override the whole file with a `SERVERS_JSON` variable (it is not a secret).

Workers cannot connect out on port 25, which is fine because sending uses the submission ports.

## Login captcha (optional)

Cloudflare Turnstile protects the sign-in form when both are set:
- `turnstile.siteKey` in `config/servers.json` (or the `TURNSTILE_SITE_KEY` variable)
- the `TURNSTILE_SECRET` Worker secret (`npx wrangler secret put TURNSTILE_SECRET`)

Leave either out and the login works without a captcha. This is the only secret ratmail uses, and it protects the login form only, not mail.

## Deploy

```sh
npm install
npx wrangler d1 create ratmail          # paste the database_id into wrangler.jsonc
npm run db:init                          # creates the two tables
npx wrangler deploy
```

Then add a custom domain (for example `ratmail.ratlan.net`) to the Worker in the Cloudflare dashboard or under `routes` in `wrangler.jsonc`. The app needs HTTPS for its cookie.

### Mailcow notes

- Mailcow's netfilter bans IPs after repeated failed logins, and all ratmail traffic comes from Cloudflare's IP ranges. ratmail forwards the browser's real IP (IMAP `ID` with `x-originating-ip`, SMTP `XCLIENT ADDR=`), so trust Cloudflare's ranges on the mail server and it will log and ban the real user instead:
  - Dovecot (`data/conf/dovecot/extra.conf` on Mailcow): `login_trusted_networks = <ranges from https://www.cloudflare.com/ips/>`
  - Postfix (`data/conf/postfix/extra.cf`): `smtpd_authorized_xclient_hosts = <same ranges, IPv6 in [brackets]>`
  - Servers that don't trust the ranges ignore the forwarded IP.
- Use your normal mailbox password, or a Mailcow app password with IMAP and SMTP allowed.

## Local development

You need a mail server to talk to. The quickest is a local Dovecot plus the bundled SMTP sink:

```sh
cp .dev.vars.example .dev.vars           # points at 127.0.0.1:9143 (IMAP) and :2525 (SMTP)
node scripts/smtp-sink.mjs 2525 &        # saves sent mail to .wrangler/sent-mail/
npm run db:init:local
npm run dev                              # http://127.0.0.1:8787
npm test                                 # parser and MIME unit tests
```

A minimal Dovecot setup for testing (plaintext on 127.0.0.1 only) is in `scripts/dovecot-test.conf`.

## Known gaps

- Each API call opens a fresh IMAP connection (about 100–300 ms depending on where the mail server is). A Durable Object could keep one open per user later if this feels slow.
- No conversation threading, address book or server-side filters (Sieve).
- The OX photo backgrounds are not included (no licensed images); colour and gradient backgrounds are.
