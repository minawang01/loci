# Loci

Text a message, and it becomes a note. Loci is a self-hosted notes-and-planning app whose main interface is **SMS / WhatsApp**:

- Every message lands in a human-readable `notes.md`.
- Hashtag commands turn messages into todo lists, goals and calendar blocks.
- Each night it texts you a plan for tomorrow, built from your goals and the free time you have left.

A small web dashboard lets you browse, search, edit and plan from a browser.

## What it does

| You text | What happens |
| --- | --- |
| `remember to call the dentist` | Saved as a note, auto-tagged from a keyword registry |
| `avocados #grocery` | Appended to your newest `grocery` list |
| `#todo call the dentist` | Added to today's dated todo list |
| `#done emailed the professor` | Ticks off the closest-matching todo by keyword overlap, or logs it as done |
| `#goals finish the LSAT application @December 1` + `- subtask` lines | Creates a goal with a parsed deadline and checklist, or merges into an existing goal it names |
| `#busy 9am-5pm work` | Blocks that time out of tomorrow's plan |

**Nightly plan.** Claude reads your active goals, deadlines, subtask state, remaining free time (minus `#busy` blocks) and recent momentum. It returns up to 4 concrete tasks as JSON. If a day has no free time, the model isn't called at all.

## Design decisions worth reading

- **Plain-text first.** Notes live in one markdown file you can read without the app. Goals and busy blocks, which are edited in place, live in small JSON stores with stable ids.
- **Merging goals is deliberately conservative.** Two goals merge only if one title's meaningful words are fully contained in the other's.
  - A lone generic verb never matches.
  - Ties never merge.
  - Merges are additive only: no silent re-dating or renaming.
  - A missed merge costs a duplicate; a wrong merge is unrecoverable.
- **Multi-user without storing what you don't need.**
  - Sign-up is by single-use invite, then phone OTP. Every SMS costs money, so unknown numbers get no code.
  - Each account's notes live in **its own Google Drive** folder (`drive.file` scope).
  - Phone numbers are stored only as HMAC hashes.
  - OAuth refresh tokens are encrypted at rest.
- **Abuse-resistant webhook.** Twilio signatures are validated, requests are rate-limited, OTP attempts are capped per number, and claim links are owner-only.

Full reference: [docs/GUIDE.md](docs/GUIDE.md) · API: [docs/API.md](docs/API.md)

## Architecture

```
SMS / WhatsApp ──► Twilio ──► POST /webhook/sms ──┐
                                                  ▼
Browser dashboard ──► /api (session auth) ──► Express server (Node.js)
                                                  │
                    ┌─────────────────────────────┼──────────────────────────┐
                    ▼                             ▼                          ▼
          Storage provider             Planner (Claude API)          SQLite accounts
     local disk │ per-user Google Drive   nightly + on-demand      (hashed phones, encrypted
                                                                      refresh tokens, invites)
```

**Stack:** Node.js, Express, SQLite (`better-sqlite3`), Twilio, Google Drive API (OAuth), Anthropic API, `chrono-node` for date parsing, Docker on Fly.io, Mocha (88 tests).

## Run it locally

```bash
npm install
cp .env.example .env      # then edit
npm run dev               # http://localhost:3000
npm test

# post to the webhook by hand (signature checks are off in development)
curl -X POST localhost:3000/webhook/sms --data-urlencode "Body=milk and eggs #grocery"
```

Deployment, backups, Google Drive and Twilio setup are covered in [docs/GUIDE.md](docs/GUIDE.md).

## Layout

- `server.js`: Express entrypoint
- `routes/`: webhook, dashboard API, login and OTP, invites, onboarding, claim
- `lib/`: notes, tags, goals, `#done` matching, `#busy` arithmetic, planner, SMS
  - `lib/accounts/`: sign-up, sender resolution, per-account stores
  - `lib/storage/`: local and Google Drive providers
- `public/`: dashboard, login and onboarding pages
- `test/`: Mocha suite
