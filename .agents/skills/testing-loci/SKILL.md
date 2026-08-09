---
name: testing-loci
description: How to run and end-to-end test the loci SMS-to-notes app locally (dashboard, login gate, /webhook/sms, #todo daily list, #goals goals tab, note deletion) without touching the production Fly volume.
---

# Testing loci locally

## Never test against production
`https://loci-notes.fly.dev` writes into the owner's real notes file on a Fly volume. Always run locally
against a scratch data dir.

## Start the app

```bash
cd <repo> && npm install
# no login gate (gate is disabled whenever DASHBOARD_PASSWORD is unset outside production)
DATA_DIR=/tmp/testdata PORT=3100 SKIP_TWILIO_VALIDATION=true node server.js > /tmp/loci.log 2>&1 &
# WITH the login gate enabled (needed to exercise /login):
DATA_DIR=/tmp/testdata PORT=3100 DASHBOARD_PASSWORD=testpass SKIP_TWILIO_VALIDATION=true node server.js
```

- Dashboard: http://localhost:3100/ . Username defaults to `loci` (override with `DASHBOARD_USER`).
- If another agent already owns the usual port, just pick your own (e.g. 3200) **and your own DATA_DIR**
  (e.g. /tmp/testdata2) so two servers never write the same notes.md.
- To kill only your own server without matching your shell's own command line:
  `for p in $(pgrep -f "node server.js"); do grep -qz "PORT=3200" /proc/$p/environ && kill $p; done`
- `SKIP_TWILIO_VALIDATION=true` only works when `NODE_ENV !== production`; it lets you POST the webhook
  directly with no Twilio signature.
- Port 3100 may already be occupied by another agent's server. `pgrep -af server.js` first. Do **not** run
  `pkill -f "node server.js"` from a one-shot shell — the pattern matches the shell's own command line and
  kills the call. Use `pgrep`/`kill <pid>` instead.

## The file IS the database
`$DATA_DIR/notes.md` — always assert against it directly (`cat`, `md5sum` before/after for "nothing was
written" assertions). `$DATA_DIR/goals.json` is the store for `#goals` (a JSON array of goal objects).
`$DATA_DIR/tags.json` drives the tag pills in the UI; it starts as `[]`, so seed it or no pills render.

**Seed `tags.json` with full tag OBJECTS, not bare strings.** The shape is
`{ "name": "grocery", "color": "#888888", "keywords": [], "parent": null }`. A seed of `["grocery", ...]`
makes the client's `loadTags()` throw `Cannot read properties of undefined (reading 'replace')`, which
silently aborts the composer's `await loadTags(); await loadToday(); await loadGoals(); await loadNotes()`
chain — the UI then looks like "newly composed items don't appear until reload". If you see that symptom,
suspect your fixture before filing a bug, and check the console for a `loadTags` error.

Entry format:

```
## YYYY-MM-DD HH:MM — List: <name>      (or "— Note")
Tags: a, b

- [ ] item
---
```

Seed a realistic fixture before testing (previous-day entries, an existing list, a plain note) so
"append to existing list" and "don't touch older lists" behaviours are actually exercised.

## Triggering things

- SMS: `curl -X POST localhost:3100/webhook/sms --data-urlencode "Body=#todo call the dentist"` → returns TwiML.
- Dashboard composer: the fixed bar at the bottom; it POSTs `/api/notes` and applies the same routing rules.
- `GET /api/todos/today` returns `{ name: "Todo YYYY-MM-DD", entry }`.
- Multi-line messages: `curl --data-urlencode "Body=#goals title
- sub one
- sub two"` (real newlines in the
  shell string). The dashboard composer is a single-line `<input>`, so multi-line cases can only be sent
  through the webhook — test single-line parity in the composer instead.

## #goals (goals tab)
- Rule ordering in both `routes/webhook.js` and `routes/api.js`: `#goals` is checked **first**, before
  `#create list`, `#todo` and the trailing-tag append. So `#goals #todo run a marathon` must produce a goal
  and leave `notes.md` md5 unchanged / the Today column empty.
- Parsing lives in `lib/goals.js`: chrono-node runs against the **title line only** (so `- ask for 2 letters
  of recommendation` can't be misread as a date); lines matching `^[-*]\s+` become subtasks; stray
  non-bulleted lines are dropped from subtasks but survive in `description`; the full original text is kept
  in `description`.
- Goal/subtask ids are generated (`goal_...`, `sub_...`) and are **not** positional, unlike note ids, so
  toggling is safe against list reordering.
- UI path: the **Notes / Goals** tab pair sits directly above the search box. The Goals tab hides the search
  box, the tag pills and the note board. A goal card shows created date, an optional deadline pill
  (`Dec 1 · in 114 days`, computed live from today), the title, `button.goal-subtask` rows (marker `–` /
  `✓`) and a `Mark complete` / `Mark active` button.
- Sorting is active-first then newest-first, so to actually prove "done sorts last" you must complete a goal
  that is currently displayed *above* another active goal — completing the already-last card proves nothing.
- API (all behind the auth gate): `GET /api/goals`, `POST /api/goals {text}`, `PATCH /api/goals/:id`
  (toggles, or `{status}`), `PATCH /api/goals/:id/subtasks/:subtaskId` (toggles, or `{done}`).
- Known quirk: `GOAL_TAG = /#goals\b/i` is **not anchored**, so `#goals` anywhere in a message (e.g.
  "I should write down my #goals someday") turns the whole message into a goal, unlike `#todo` which uses
  `^#todo\b`. Worth re-checking on each round — it may be intentional or may get anchored later.
- Escaping: title and subtask text go through `escapeHtml`; assert
  `document.querySelectorAll('#goalBoard img, #goalBoard b').length === 0`.

## Routing rules worth probing
`#create list <Name>` + newline items · `#todo <item>` (per-calendar-day list) · `<item> #existingtag`
(appends to an existing list only) · anything else = plain auto-tagged note.
Edge cases that have caught bugs before: bare `#todo`, `#TODO` uppercase, `#todoist ...` (must NOT be a todo —
regex uses `\b`), two `#todo`s on one day (must be one list), a pre-existing list for a *previous* day (must
not be appended to), and HTML/markdown in bodies (client escapes via `escapeHtml`; verify no `img` element is
created).

## Auth / login gate (when DASHBOARD_PASSWORD is set)
- `POST /login` with JSON `{username, password}` sets an HttpOnly `loci_session` cookie
  (`issuedAt.HMAC-SHA256`, keyed on the password itself). `POST /logout` clears it; "Sign out" is in the topbar.
- Deliberately **no** `WWW-Authenticate` header, so there is no browser Basic-Auth popup. Unauthenticated
  HTML GETs 302 to `/login`; everything else (including `/style.css`, `/app.js`, `/api/*`) gets 401 JSON.
- Scripted access still works per-request: `curl -u loci:testpass ...` or `-H "x-dashboard-secret: testpass"`.
  Use these for shell assertions instead of stealing the browser cookie.
- `/health` and `POST /webhook/sms` must stay reachable unauthenticated — Twilio must never hit the gate.
- Because the cookie is signed with the password, **restarting with a different `DASHBOARD_PASSWORD`
  invalidates every existing session** — a cheap way to test session revocation.
- Login form fields keep their values after a failed attempt; `triple_click` to clear the username before
  retyping or you end up with `lociloci`.
- With no password set, the "Sign out" button still renders but just bounces `/logout` → `/login` → `/`.

## Deletion
- `DELETE /api/notes/:id?dateTime=<entry dateTime>`; `id` is the entry's **position in notes.md**, not its
  feed position, and ids shift whenever an earlier entry is deleted. The `?dateTime=` guard 404s on mismatch.
- UI: `×` appears on card hover (nested `button[data-delete]` inside `div.card[role=button]`), plus a
  "Delete" button in the detail view. Both go through `window.confirm()`.
- Highest-value adversarial tests: delete from a **tag-filtered/search view** (feed position ≠ file id), and a
  **stale-id delete** — park a second tab on a *detail view* (that freezes its 15s poll so ids stay stale),
  delete an earlier entry in the first tab, then delete from the stale tab; the guard must 404 and the client
  must alert `Could not delete that note — it may have already changed. Reloading.`
- Verify deletes byte-exactly: keep a pristine `cp notes.md /tmp/seed-notes.md`, then in Python rebuild
  "seed minus exactly that block" (split on `(?=\n## )`) and compare strings. `md5sum` before/after is the
  assertion for "cancel deleted nothing".

## Frontend notes
- Feed polls every 15s but is suppressed while a detail view is open (`selectedIndex !== null`) — to test,
  open a card, inject a note via the webhook, wait >20s, and confirm the detail view didn't change.
- Today's todo list is hidden from the plain feed but must still appear in search and tag-filter results.
- Layout breakpoint at 900px: resize with `wmctrl -r :ACTIVE: -e 0,0,0,700,760` (and re-maximize with
  `wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`) rather than devtools.
- The dashboard caches nothing, but if you restart the server with new data the open tab may show stale
  tags/entries for up to 15s — press F5.
- Cards are `div[role=button][tabindex=0]` with a keydown handler, not `<button>`. Keyboard check: Tab from
  the search box reaches a card (visible focus ring), Enter and Space both open the detail view; Tab order
  then goes into that card's `×`, so shift+Tab back to the card before pressing Space.

## Devin Secrets Needed
None for local testing. `DASHBOARD_PASSWORD` can be set to any throwaway value (e.g. `testpass`) to exercise
the login gate. The real production vars (`TWILIO_AUTH_TOKEN`, `PUBLIC_URL`, the real dashboard password) are
not required and should not be used locally.
