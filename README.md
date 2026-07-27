# mindchuk

Personal text-to-note app: text or WhatsApp a message to your Twilio number, and
it lands in a single human-readable `notes.md` file. A small dashboard lets you
browse, search, and add notes from a browser.

- `server.js` — Express entrypoint
- `lib/notes.js` — appends notes/lists to `$DATA_DIR/notes.md`
- `lib/tags.js` — tag registry (`$DATA_DIR/tags.json`) with keyword auto-tagging
- `routes/webhook.js` — Twilio inbound webhook (`POST /webhook/sms`), signature-validated and rate-limited
- `routes/api.js` — JSON API behind basic auth
- `public/` — dashboard, also behind basic auth

## Message formats

| You text | Result |
| --- | --- |
| `#create list Groceries` + items on following lines | new checklist entry |
| `avocados #grocery` | appends to the newest existing `grocery` list, otherwise saved as a tagged note |
| `remember to call the dentist` | plain note, auto-tagged from the tag registry keywords |

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
| `DATA_DIR` | no | where `notes.md`/`tags.json` live; defaults to `./data` |
| `DASHBOARD_USER` | no | basic-auth user, defaults to `mindchuk` |
| `DASHBOARD_PASSWORD` | **in production** | basic-auth password for dashboard and `/api` |
| `WEBHOOK_RATE_LIMIT` | no | inbound requests per minute per IP, defaults to 30 |
| `SKIP_TWILIO_VALIDATION` | no | local-only escape hatch; rejected at startup in production |

In production the server **refuses to start** without `TWILIO_AUTH_TOKEN`,
`PUBLIC_URL`, and `DASHBOARD_PASSWORD`, and refuses to start if
`SKIP_TWILIO_VALIDATION=true`.

`/health` is the only unauthenticated endpoint: `/webhook/sms` requires a valid
Twilio signature, and the dashboard plus `/api` require basic auth (or the same
password sent as an `x-dashboard-secret` header for scripts).

## Deploying (Fly.io)

Fly is the cheapest option that is both always-on and has a real persistent
filesystem — roughly $2/month for a `shared-cpu-1x` 256 MB machine plus ~$0.15
for a 1 GB volume. Render's free tier and Railway's trial both fall short (see
[Host trade-offs](#host-trade-offs)).

```bash
# one-time
curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy            # accept the existing fly.toml; pick an app name
fly volumes create mindchuk_data --size 1 --region sjc

fly secrets set \
  TWILIO_ACCOUNT_SID=AC... \
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
`mindchuk_data` volume at `/data`.

### Custom domain under minawang.com

```bash
fly certs add mindchuk.minawang.com    # prints the DNS records to create
# add the CNAME/A+AAAA records at your DNS provider, then:
fly certs show mindchuk.minawang.com
fly secrets set PUBLIC_URL=https://mindchuk.minawang.com
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

## Persistence and syncing

`notes.md` and `tags.json` live in `DATA_DIR`, which is the Fly volume at
`/data`. Constraints worth knowing:

- A Fly volume is attached to a single machine, so keep this app at one machine
  (`min_machines_running = 1`, no scaling out). Volumes are not backed up by
  default; `fly volumes snapshots list <volume-id>` shows the daily snapshots
  Fly takes, and you can also copy the file down yourself.
- Pull the current file locally (this is the simplest "sync to Dropbox/Drive"
  path — write it into your synced folder and run it on a cron):

  ```bash
  fly ssh console -C "cat /data/notes.md" > ~/Dropbox/mindchuk/notes.md
  # or, for the whole directory
  fly ssh sftp get /data/notes.md ~/Dropbox/mindchuk/notes.md
  ```

- True two-way sync (editing the file in Dropbox and having the app see it) is
  not possible with a Fly volume — the host filesystem is not reachable by
  Dropbox/Drive clients. If you want that, the app would need to read/write
  through a cloud-storage API instead, which is a bigger change than this task.

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
