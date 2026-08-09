# loci

Personal text-to-note app: text or WhatsApp a message to your Twilio number, and
it lands in a single human-readable `notes.md` file. A small dashboard lets you
browse, search, and add notes from a browser.

- `server.js` — Express entrypoint
- `lib/notes.js` — appends notes/lists to `$DATA_DIR/notes.md`
- `lib/tags.js` — tag registry (`$DATA_DIR/tags.json`) with keyword auto-tagging
- `lib/goals.js` — `#goals` parsing and the goal store (`$DATA_DIR/goals.json`)
- `routes/webhook.js` — Twilio inbound webhook (`POST /webhook/sms`), signature-validated and rate-limited
- `routes/api.js` — JSON API behind the auth gate
- `public/` — dashboard and login page

## Current deployment

| | |
| --- | --- |
| URL | https://loci-notes.fly.dev |
| Fly app | `loci-notes`, personal org, 1 machine in `sjc` (`loci` was taken) |
| Volume | `loci_data`, mounted at `/data` |
| SMS number | `+1 641 381 9773`, webhook set to `POST /webhook/sms` |
| Dashboard | sign in at `/login` as user `loci`, password in the `DASHBOARD_PASSWORD` Fly secret |

Still outstanding: the WhatsApp sandbox webhook (Console-only, see below) and
`RCLONE_CONFIG_DRIVE_TOKEN` for backups.

## Message formats

| You text | Result |
| --- | --- |
| `#goals finish the LSAT application by December 1` + optional `- subtask` lines | new goal with a parsed deadline and checklist, shown under the dashboard's Goals tab |
| `#create list Groceries` + items on following lines | new checklist entry |
| `#todo call the dentist` | appends a bullet to the list for that calendar day (`Todo YYYY-MM-DD`), creating it on the day's first item |
| `avocados #grocery` | appends to the newest existing `grocery` list, otherwise saved as a tagged note |
| `remember to call the dentist` | plain note, auto-tagged from the tag registry keywords |

Rules are matched in that order, so `#goals` wins over `#todo` when a message
carries both.

### Goals

`#goals` only counts as the first token of the message, like `#todo`, so a note
that happens to mention `#goals` mid-sentence stays a note.

The first line becomes the title, or — when the tag sits alone on its line —
the next non-empty, non-bulleted line, indented or not. [chrono-node](https://github.com/wanasit/chrono)
reads a date phrase out of that line only (subtask lines are ignored, so
"ask for 2 letters" is never mistaken for a time) and stores it as `deadline`,
or `null` when there is no date. Lines starting with `-` or `*` become
independently checkable subtasks; other lines are kept in `description` but do
not become structure. Goals live in `$DATA_DIR/goals.json` rather than
`notes.md`, since they are edited in place — unlike notes, whose ids are file
positions, each goal and subtask carries a generated id that survives the list
changing around it.

## Local development

```bash
npm install
cp .env.example .env      # then edit
npm run dev               # or: npm start
open http://localhost:3000
```

With `NODE_ENV` unset (development), signature validation and the dashboard auth
gate are skipped unless you configure them, so you can post to the webhook by
hand:

```bash
curl -X POST localhost:3000/webhook/sms --data-urlencode "Body=milk and eggs #grocery"
```

## Environment variables

All of these are documented in `.env.example`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | for outbound/API use | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | **in production** | validates the `X-Twilio-Signature` header |
| `TWILIO_SMS_NUMBER` | no | your SMS number, E.164 |
| `TWILIO_WHATSAPP_NUMBER` | no | WhatsApp sender (sandbox: `whatsapp:+14155238886`) |
| `PUBLIC_URL` | **in production** | public origin, no trailing slash; must match the URL configured in Twilio, since Twilio signs that exact URL |
| `PORT` | no | defaults to 3000 |
| `NODE_ENV` | **in production** | set to `production` to enforce validation + auth |
| `DATA_DIR` | no | where `notes.md`/`tags.json`/`goals.json` live; defaults to `./data` |
| `DASHBOARD_USER` | no | login user, defaults to `loci` |
| `DASHBOARD_PASSWORD` | **in production** | login password for the dashboard and `/api` |
| `BACKUP_REMOTE` | no | rclone `remote:path` to mirror `DATA_DIR` into; backups are off when unset |
| `BACKUP_INTERVAL_MINUTES` | no | defaults to 15 |
| `RCLONE_CONFIG_DRIVE_*` | for backups | rclone remote config, including the OAuth token |
| `TWILIO_VERIFY_SERVICE_SID` | for phone sign-in | Verify service that sends the login code |
| `LOGIN_PHONE_NUMBERS` | for phone sign-in | comma-separated E.164 numbers allowed to sign in |
| `WEBHOOK_RATE_LIMIT` | no | inbound requests per minute per IP, defaults to 30 |
| `SKIP_TWILIO_VALIDATION` | no | local-only escape hatch; rejected at startup in production |

In production the server **refuses to start** without `TWILIO_AUTH_TOKEN`,
`PUBLIC_URL`, and `DASHBOARD_PASSWORD`, and refuses to start if
`SKIP_TWILIO_VALIDATION=true`.

`/health` and `/login` are the only unauthenticated endpoints: `/webhook/sms`
requires a valid Twilio signature, and the dashboard plus `/api` require a
session. Signing in at `/login` sets a signed, HTTP-only session cookie that
lasts 30 days; changing `DASHBOARD_PASSWORD` invalidates every existing session.
Scripts can skip the form and authenticate per request with basic auth or the
same password sent as an `x-dashboard-secret` header:

```bash
curl -u loci:'<password>' https://loci-notes.fly.dev/api/notes
```

Those header credentials are honoured only for non-browser clients (requests
without `Sec-Fetch-*` headers). A browser that has ever been given basic-auth
credentials for the origin replays them on every request, which would
re-authenticate you the moment you signed out — so in a browser the session
cookie is the only thing that counts.

### Signing in with a phone number

The login page offers "Text me a code" when both `TWILIO_VERIFY_SERVICE_SID` and
`LOGIN_PHONE_NUMBERS` are set; otherwise it is the password form alone. The code
is sent through [Twilio Verify](https://www.twilio.com/docs/verify), which uses
Twilio's own registered senders rather than `TWILIO_SMS_NUMBER` — so it is
delivered even though outbound SMS from the loci number is blocked pending A2P
10DLC registration. Each verification costs about $0.05.

Create the service once (Console → Verify → Services, or via the API) and set
both variables:

```bash
fly secrets set TWILIO_VERIFY_SERVICE_SID=VAxxxx LOGIN_PHONE_NUMBERS='+15551234567' --app loci-notes
```

Only listed numbers can sign in. A number that isn't listed gets the same
"a code is on its way" response and no text, so the page never reveals who is
allowed in. Requests are capped at 5 codes and 10 attempts per 15 minutes per
IP, and a successful code sets exactly the same session cookie the password form
does.

Clicking a checklist item — in the Today column, on a list card, or in the
detail view — crosses it out and flips its `- [ ]` to `- [x]` in `notes.md`, so
the state is the file rather than anything in the browser. Items are addressed
by their position among the entry's checkbox lines.

Deleting a note (the `×` on a card, or **Delete** in the detail view) rewrites
`notes.md` without that entry. There is no undo in the app — the safety net is
the Google Drive backup, which keeps file version history.

## Deploying (Fly.io)

Fly is the cheapest option that is both always-on and has a real persistent
filesystem (see [Persistence and backup](#persistence-and-backup) for how the
notes get off the host) — roughly $2/month for a `shared-cpu-1x` 256 MB machine plus ~$0.15
for a 1 GB volume. Render's free tier and Railway's trial both fall short (see
[Host trade-offs](#host-trade-offs)).

```bash
# one-time
curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy            # accept the existing fly.toml; pick an app name
fly volumes create loci_data --size 1 --region sjc

fly secrets set \
  TWILIO_ACCOUNT_SID=AC... \
  RCLONE_CONFIG_DRIVE_TOKEN='<json from rclone authorize "drive">' \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_SMS_NUMBER=+1555... \
  TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886 \
  PUBLIC_URL=https://<app-name>.fly.dev \
  DASHBOARD_PASSWORD='<long random string>'

fly deploy
curl https://<app-name>.fly.dev/health   # {"ok":true}
```

`fly.toml` already sets `NODE_ENV=production`, `DATA_DIR=/data`,
`min_machines_running = 1` (no cold starts for Twilio), and mounts the
`loci_data` volume at `/data`.

### Custom domain under minawang.com

```bash
fly certs add loci.minawang.com    # prints the DNS records to create
# add the CNAME/A+AAAA records at your DNS provider, then:
fly certs show loci.minawang.com
fly secrets set PUBLIC_URL=https://loci.minawang.com
```

Update the webhook URL in the Twilio Console to match, or signature validation
will reject inbound messages.

### Redeploying after a change

```bash
git push                # keep the repo in sync
fly deploy              # rebuilds the image and restarts the machine
fly logs                # tail logs
fly status
```

Changing a secret (`fly secrets set ...`) restarts the app on its own — no
deploy needed. The volume is not touched by deploys, so notes persist.

## Persistence and backup

`notes.md`, `tags.json`, and `goals.json` live in `DATA_DIR`, the Fly volume mounted at
`/data`. The volume survives `fly deploy` and machine restarts. A Fly volume is
attached to a single machine, so keep this app at one machine
(`min_machines_running = 1`, no scaling out).

That is persistence, not backup — so the app also mirrors `DATA_DIR` to Google
Drive with `rclone` every `BACKUP_INTERVAL_MINUTES` (default 15). Backups are
skipped entirely unless `BACKUP_REMOTE` is set, so local development is
unaffected.

### One-time Google Drive setup

```bash
# on your laptop, where a browser is available
rclone authorize "drive"
# approve in the browser; it prints a JSON blob containing a refresh token

fly secrets set RCLONE_CONFIG_DRIVE_TOKEN='<the JSON blob>'
```

`fly.toml` already sets the non-secret half (`RCLONE_CONFIG_DRIVE_TYPE=drive`,
`RCLONE_CONFIG_DRIVE_SCOPE=drive.file`, `BACKUP_REMOTE=drive:loci`). rclone
builds its whole config from those `RCLONE_CONFIG_DRIVE_*` variables, so there is
no `rclone.conf` to manage on the host. `drive.file` scope means the app can only
see files it created — it has no access to the rest of your Drive.

After `fly deploy`, `fly logs` shows `Backed up /data to drive:loci` on
startup and then once per interval; failures are logged and never affect request
handling. Run one on demand with `npm run backup` (locally) or
`fly ssh console -C "npm run backup"`.

### Restoring

```bash
fly ssh console -C "rclone copy drive:loci /data"
# or pull a copy down to your laptop
fly ssh sftp get /data/notes.md ./notes.md
```

### Two caveats

- The mirror is **one-way** (Fly → Drive). Fly is the source of truth, so
  editing `notes.md` in Drive will be overwritten by the next backup. True
  two-way sync would mean reading and writing through the Drive API on every
  request instead of the filesystem — a rewrite of `lib/notes.js`, deliberately
  out of scope.
- `rclone copy` never deletes on the remote, so a note deleted on Fly stays in
  the Drive copy. That is the desirable behaviour for a backup: a bad local
  state can't destroy it.
- Fly also takes its own daily volume snapshots — `fly volumes snapshots list
  <volume-id>` — as a second line of defence.

### Host trade-offs

| Host | Always-on | Persistent files | Cost |
| --- | --- | --- | --- |
| **Fly.io** (configured here) | yes, with `min_machines_running = 1` | yes, volume mounted at `/data` | ~$2–3/mo |
| Render | free tier spins down after ~15 min idle; cold start can exceed Twilio's 15 s webhook timeout, so the first text after idling is lost | free tier filesystem is ephemeral and wiped on every deploy/restart — persistent disks need the $7/mo Starter plan | free (with caveats) or $7/mo |
| Railway | yes | yes, volumes | no free tier; Hobby $5/mo (includes $5 usage credit) |

## Twilio setup

### 1. Buy an SMS number

1. Sign in to the [Twilio Console](https://console.twilio.com).
2. **Phone Numbers → Manage → Buy a number**.
3. Pick your country, check the **SMS** capability filter, then **Search**.
4. **Buy** a number (US local numbers are ~$1.15/month plus per-message fees).
   On a trial account you can only exchange messages with verified numbers —
   verify your own phone under **Phone Numbers → Verified Caller IDs**.
5. Copy the number into `TWILIO_SMS_NUMBER`, and copy the **Account SID** and
   **Auth Token** from the Console home page into `TWILIO_ACCOUNT_SID` /
   `TWILIO_AUTH_TOKEN`.

### 2. Point SMS at the webhook

1. **Phone Numbers → Manage → Active numbers →** click your number.
2. Scroll to **Messaging → A message comes in**.
3. Set it to **Webhook**, URL `https://<deployed-url>/webhook/sms`, method
   **HTTP POST**.
4. **Save configuration**, then text the number — you should get a reply and see
   the note in the dashboard.

### 3. WhatsApp sandbox (easy path)

1. **Messaging → Try it out → Send a WhatsApp message**.
2. On the **Sandbox** tab, send the shown `join <two-words>` code from WhatsApp
   to **+1 415 523 8886** to link your phone.
3. On the **Sandbox settings** tab, set **When a message comes in** to
   `https://<deployed-url>/webhook/sms`, method **HTTP POST**, and save.
4. Set `TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886`.

The sandbox is fine for personal use; the only catches are that the sender
number is shared and your phone has to re-join after 72 hours of inactivity.

### 4. Full WhatsApp sender (optional, slower)

**Messaging → Senders → WhatsApp senders → New sender** requires a Meta
Business account, business verification, and a number not already on WhatsApp.
Approval takes days, so start with the sandbox.

### Troubleshooting

- `403 Invalid Twilio signature` — `PUBLIC_URL` does not exactly match the URL
  configured in the Twilio Console (http vs https, trailing slash, custom domain
  vs `*.fly.dev`).
- `500 Webhook validation is not configured` — `TWILIO_AUTH_TOKEN` or
  `PUBLIC_URL` is missing on the host.
- Twilio Console **Monitor → Logs → Errors** shows the response body Twilio got,
  which is the fastest way to tell these apart.
