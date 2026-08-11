# loci

Personal text-to-note app: text or WhatsApp a message to your Twilio number, and
it lands in a single human-readable `notes.md` file. A small dashboard lets you
browse, search, and add notes from a browser.

- `server.js` — Express entrypoint
- `lib/notes.js` — appends notes/lists to `$DATA_DIR/notes.md`
- `lib/tags.js` — tag registry (`$DATA_DIR/tags.json`) with keyword auto-tagging
- `lib/goals.js` — `#goals` parsing and the goal store (`$DATA_DIR/goals.json`)
- `lib/busy.js` — `#busy` parsing, the block store (`$DATA_DIR/busy.json`) and the free-time arithmetic
- `lib/plan.js` — nightly plan generation (Claude) and its scheduler
- `lib/sms.js` — outbound SMS/WhatsApp sending
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
| `#goals finish the LSAT application @December 1` + optional `- subtask` lines | new goal with a parsed deadline and checklist, shown under the dashboard's Goals tab — or folded into an existing goal that names the same thing |
| `#busy 9am-5pm work` or `#busy 3pm for 2 hrs dentist` | marks that time unavailable on the day it names (today unless you say otherwise), which the nightly plan subtracts from its window |
| `#create list Groceries` + items on following lines | new checklist entry |
| `#todo call the dentist` | appends a bullet to the list for that calendar day (`Todo YYYY-MM-DD`), creating it on the day's first item — each line of a multi-line message becomes its own item |
| `#done emailed the professor` | crosses the closest matching item off that day's todo list, or adds it already crossed off |
| `avocados #grocery` | appends to the newest existing `grocery` list, otherwise saved as a tagged note |
| `remember to call the dentist` | plain note, auto-tagged from the tag registry keywords |

Rules are matched in that order, so `#goals` wins over `#todo` when a message
carries both.

### Done

`#done` closes the loop on `#todo`: it reads the same day-scoped list and adds
no storage of its own. The text is matched against the list's items by keyword
overlap (`lib/done.js`) — lowercased, punctuation stripped, stopwords dropped,
crudely stemmed so "emailed" reaches "email". Two shared keywords is a match;
one is only enough when a side has nothing else to offer, so `#done dishes`
finds `- [ ] dishes` while `#done went for a walk` matches nothing. The best
scoring item wins, preferring an unfinished one on a tie.

A match is ticked off via the same `setItemDone` the dashboard checkboxes use.
No match means the text is appended to the day's list already crossed off,
creating that list if `#done` is the first thing you send all day — so the list
stays a record of what happened, not just what was planned.

### Goals

`#goals` only counts as the first token of the message, like `#todo`, so a note
that happens to mention `#goals` mid-sentence stays a note.

The first line becomes the title, or — when the tag sits alone on its line —
the next non-empty, non-bulleted line, indented or not. `@` marks the deadline
explicitly — `#goals ship the essay @friday`, `#goals apply @2026-12-01` —
which is unambiguous where prose is not. Everything after the last `@` is the
date phrase; when it doesn't parse as a date the whole line falls back to
[chrono-node](https://github.com/wanasit/chrono) prose parsing, so `by December
1` still works and an `@handle` in a title is left alone. Either way the date
is read out of the title line only (subtask lines are ignored, so "ask for 2
letters" is never mistaken for a time) and stored as `deadline`, or `null` when
there is no date. Lines starting with `-` or `*` become
independently checkable subtasks; other lines are kept in `description` but do
not become structure. Goals live in `$DATA_DIR/goals.json` rather than
`notes.md`, since they are edited in place — unlike notes, whose ids are file
positions, each goal and subtask carries a generated id that survives the list
changing around it.

Restating a goal amends it rather than duplicating it: `#goals tiktok essays`
folds into an existing `tiktoks`, appending any new subtasks, filling in a
deadline if there wasn't one, and keeping the more descriptive of the two
titles. Two titles name the same goal when one's meaningful words (lowercased,
depunctuated, crudely singularised, stopwords dropped) are entirely contained in
the other's. That bar is deliberately high, because merging is destructive and
there is no undo — a near-miss costs more than a duplicate does:

- `LSAT prep` and `LSAT application` each carry a word the other lacks, so they
  stay separate.
- A lone generic verb identifies nothing — `run` fits `run a marathon` and `run
  the shop` equally — so a one-word title that is only a verb never matches.
- When two live goals fit equally well, neither is chosen: the message becomes
  its own goal and the reply names the candidates, since picking by storage
  order would fold it into whichever happened to be saved first. A title that
  matches one of them *word for word* is the exception — nothing can claim it
  more strongly — so restating the same goal amends it rather than piling up
  duplicates. The dashboard composer shows the same warning the SMS reply does.
- A merge is additive only. An existing deadline is left alone and a title is
  replaced only by one carrying *more* words, so a passing mention can't
  re-date or rename a goal behind your back — those are edits to make
  deliberately on the Goals tab.

The reply says which of the three happened, and the Goals tab can edit or
delete either way.

Goals are editable from the dashboard — title and deadline in place, delete
behind a confirmation that names how many subtasks go with it.

### Busy

`#busy` is the only thing that shrinks the day the nightly plan is built
against. chrono reads the range and any day phrase in one pass — `#busy
9am-5pm work`, `#busy tomorrow 9am-5pm work`, `#busy monday 2-4pm dentist` —
and whatever text is left over becomes the label. A day named *after* the time
instead (`#busy 7am-11pm conference on 2026-08-13`, `#busy 3pm for 1 hr jog on
Saturday`) is a second chrono result that the time pass doesn't consume, so it
is looked for in the leftover text and moves the whole block onto that day, by
whole calendar days so the times survive a daylight-saving boundary. Both
syntaxes get this.

Forward-dating is off, so a `#busy 7-8pm dinner` sent at 8pm still means
tonight rather than tomorrow — but a *named weekday* that lands in the past is
pushed on a week, since "monday" said on a Tuesday means the coming Monday and
a block in the past can never affect a plan.
`noon` and `midnight` are rewritten to `12pm`/`12am` first, since chrono reads
`noon to 1pm` but takes `noon-1pm` for a stray `-1`.

A start time plus a length works too: `#busy 3pm for 2 hrs dentist`, `#busy 9am
8 hours work`, `#busy 6am for 45 min gym`, `#busy 2pm for an hour`. chrono reads
"for 2 hrs" as a moment two hours in the *past* rather than a length, so the
duration is lifted out with a regex before chrono sees the text and then added
to the start.

One or the other is required: `#busy work` and `#busy 3pm dentist` have no
duration to subtract, so they are refused rather than stored as a zero-length
block. So is anything longer than 16h, the length of the planning window
itself — a reversed range like `#busy 5pm-3pm` is resolved by chrono as ending
tomorrow afternoon, and a 22h block silently eating the day is far likelier to
be a typo than a real commitment.

Blocks append per calendar day, keyed by date in `$DATA_DIR/busy.json`, and overlapping
ones are stored exactly as sent — they are collapsed only when availability is
computed, so the file stays a faithful log.

The dashboard's **Busy** tab shows the next seven days, empty ones included, so
the week reads as a calendar rather than a list of commitments. `GET /api/busy`
takes `from` and `days` (up to 60) and returns one record per day; a single
block can be dropped with `DELETE /api/busy/:date/:id`, which is the only way to
undo one — there is no `#unbusy`.

## Nightly plan

Each night the app asks Claude for a short plan for the next day and texts it
over. It reads active goals (with deadlines, days remaining, and each subtask's
state), the free window (`7am–11pm` by default, minus that day's `#busy`
blocks), and the todo items crossed off over the last three days as loose
momentum context. One API call, no SDK.

When blocks exist, the prompt lists them and states the time actually left
(`That leaves 8h free: 7:00am–9:00am, 5:00pm–11:00pm`). Overlaps are merged and
blocks clipped to the window at this point, so a 5–8am gym slot only costs the
hour of it that was plannable. A day with **no** free time skips the model call
entirely and returns a sentence saying so, rather than paying to squeeze
suggestions into time that doesn't exist.

The prompt asks for at most 4 tasks and usually 2-3, and leaves the count to the
model's read of the work: several quick, bounded tasks can share a day, while an
open-ended one absorbs it. It also asks the model to reuse an existing unfinished
subtask rather than invent a task, to weight nearer deadlines while still rotating
undated goals in, and to answer as JSON. The reply is parsed, hard-capped at 4,
and formatted one line per task:

```
Plan for 2026-08-10:
• draft personal statement (finish LSAT application)
• ask Priya for a referral (ask Priya for a referral)
```

The job is off unless `ANTHROPIC_API_KEY` and `PLAN_PHONE_NUMBER` are both set,
like backups and phone sign-in. It runs at `PLAN_SEND_TIME` (default `21:30`)
in the **host's** local time, which `fly.toml` pins to `America/New_York`. No plan
is persisted — there is no plan history and no feedback loop yet.

The dashboard's **Make a plan** control, on the Goals tab, runs the same
generation on demand and shows the result on the page rather than texting it —
which is the only way to read a plan while outbound SMS is carrier-blocked. Any
day from today onwards can be picked, not just tomorrow; the chosen date drives
everything downstream, including which `#busy` blocks are subtracted and how
many days remain on each goal.
It calls `POST /api/plan` with an optional `{"date": "YYYY-MM-DD"}` — omitted,
it still means tomorrow — which texts the plan too when passed `{"send": true}`
and a `PLAN_PHONE_NUMBER` is configured. A send failure does not lose the plan:
the response still carries it, with `sendError` alongside.

To send one from the shell instead:

```bash
npm run plan
```

A failure — bad key, unparseable reply, Twilio rejection — is logged and
swallowed, so a bad night never takes the server down with it.

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
| `DATA_DIR` | no | where `notes.md`/`tags.json`/`goals.json`/`busy.json` live; defaults to `./data` |
| `DASHBOARD_USER` | no | login user, defaults to `loci` |
| `DASHBOARD_PASSWORD` | **in production** | login password for the dashboard and `/api` |
| `BACKUP_REMOTE` | no | rclone `remote:path` to mirror `DATA_DIR` into; backups are off when unset |
| `BACKUP_INTERVAL_MINUTES` | no | defaults to 15 |
| `RCLONE_CONFIG_DRIVE_*` | for backups | rclone remote config, including the OAuth token |
| `TWILIO_VERIFY_SERVICE_SID` | for phone sign-in | Verify service that sends the login code |
| `LOGIN_PHONE_NUMBERS` | for phone sign-in | comma-separated E.164 numbers allowed to sign in |
| `ANTHROPIC_API_KEY` | for the nightly plan | Claude API key |
| `PLAN_PHONE_NUMBER` | for the nightly plan | where the plan is texted; prefix `whatsapp:` to send over WhatsApp |
| `PLAN_SEND_TIME` | no | 24h host-local time, defaults to `21:30` |
| `CLAUDE_MODEL` | no | defaults to `claude-sonnet-4-6` |
| `PLAN_DAY_START` / `PLAN_DAY_END` | no | the free window, defaults `7am`/`11pm` |
| `TZ` | no | host timezone, so note timestamps, daily todo lists and `PLAN_SEND_TIME` follow your clock rather than UTC. `fly.toml` sets `America/New_York` |
| `WEBHOOK_RATE_LIMIT` | no | inbound requests per minute per IP, defaults to 30 |
| `SKIP_TWILIO_VALIDATION` | no | local-only escape hatch; rejected at startup in production |

In production the server **refuses to start** without `TWILIO_AUTH_TOKEN`,
`PUBLIC_URL`, and `DASHBOARD_PASSWORD`, and refuses to start if
`SKIP_TWILIO_VALIDATION=true`.

`/health`, `/login`, `/privacy` and `/terms` are the only unauthenticated
endpoints — the last two are public because A2P 10DLC campaign registration
requires reachable links to them. `/webhook/sms`
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

`notes.md`, `tags.json`, `goals.json`, and `busy.json` live in `DATA_DIR`, the Fly volume mounted at
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
