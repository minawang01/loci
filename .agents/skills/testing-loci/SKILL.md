---
name: testing-loci
description: How to run and end-to-end test the loci SMS-to-notes app locally (dashboard, login gate, /webhook/sms, #todo daily list and per-line items, #done fuzzy cross-off, #goals goals tab with edit/delete/merge and @deadline, #busy blocks and the Busy week tab, checklist item check-off, note deletion, timezone day-scoping, the paid /api/plan endpoint and planning any chosen day) without touching the production Fly volume.
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

## NEVER let the server inherit ANTHROPIC_API_KEY
`POST /api/plan` (the "Plan tomorrow" button) calls the Anthropic API and **costs money per click**. The
agent shell on this box often already has `ANTHROPIC_API_KEY` exported, and `node server.js` inherits it —
so a "confirm it 503s without a key" check will silently return **200 and bill a real request** instead.
Always start the server with the key stripped and verify:

```bash
env -u ANTHROPIC_API_KEY DATA_DIR=... PORT=... node server.js
# verify it really is absent in the child process, not just in your shell:
tr '\0' '\n' < /proc/<pid>/environ | grep -c '^ANTHROPIC_API_KEY='   # must print 0
curl -s -X POST -u loci:testpass localhost:PORT/api/plan   # -> 503 ANTHROPIC_API_KEY is not configured
```

Never click the "Plan tomorrow" button in the dashboard during testing.

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
- A **bare `#goals` line** promotes the next non-empty, non-bulleted line (indentation allowed) to the title
  and excludes that line from the subtask scan. Two shapes worth testing: tag line + indented title +
  bullets (title parsed, bullet count unchanged), and tag line + bullets only (title falls back to
  `Untitled goal` and **no bullet is stolen as the title** — assert the subtask count, not just the title).
- Known quirk: `GOAL_TAG = /#goals\b/i` is **not anchored**, so `#goals` anywhere in a message (e.g.
  "I should write down my #goals someday") turns the whole message into a goal, unlike `#todo` which uses
  `^#todo\b`. Worth re-checking on each round — it may be intentional or may get anchored later.
- Escaping: title and subtask text go through `escapeHtml`; assert
  `document.querySelectorAll('#goalBoard img, #goalBoard b').length === 0`.

### Goal edit / delete (inline, on each card)
- Each card carries `Mark complete` + `Edit` + `Delete`. `Edit` swaps the title line for
  `input[data-edit-title]` + `input[data-edit-deadline]` and the buttons for `Save`/`Cancel`; state is the
  module-level `editingGoal` in `public/app.js`, so only one card edits at a time.
- `Save` sends **only** `{title, deadline}` to `PATCH /api/goals/:id`. Subtasks, their `done` flags and the
  goal `status` therefore have to be preserved **server-side** — the strongest test is to tick a subtask
  *before* editing and confirm the tick survives Save **and** a reload. A build that rebuilt the goal from
  the PATCH body would silently drop them, and the UI would look fine until you refresh.
- Deadlines round-trip through **midday** (`deadlineFromInput` → `T12:00:00`), which is what stops a TZ
  offset shifting the day. Assert the stored value is `...T12:00:00.000Z` and the pill shows the day you
  picked, not ±1.
- `Delete` confirms with the goal title **and** its subtask count (`and its 2 subtask(s)`). Always check a
  *neighbouring* goal still has its own subtasks afterwards — deleting the only goal proves nothing.
- The 15s poll is skipped while `editingGoal !== null` (and while a note detail is open). To test, type into
  an open edit field and idle **>20s**; the field must still hold the unsaved text.
- GUI gotcha: an `input[type=date]` has three segments. Clicking mid-field can land you on day/year and your
  typed `MMDDYYYY` goes in scrambled (e.g. year `202026`). Click the **left-most (month) segment** then type
  all 8 digits, and verify the value before saving.

### Goal merging (destructive, no undo — probe it hard)
`createGoal` no longer always appends: it collects **all** live (`status !== 'done'`) goals that `sameGoal()`
matches and folds the new text in **only when exactly one matches**, returning
`{goal, merged, addedSubtasks, ambiguous}`. The webhook then replies `Added to your existing goal "..."`
instead of `Goal saved:`. With **two or more** matches it creates a new goal and returns
`ambiguous: [titles]`, and the SMS reply appends `It could have joined "a" or "b" — merge them on the
dashboard if you meant one of those.`
- `sameGoal(a, b)` = lowercase, strip non-alphanumerics, drop a ~21-word `STOPWORDS` list, crude `s`-stemmer
  (`length > 3`, not `ss`), then **subset containment**: true iff the smaller word-set is wholly inside the
  larger. So `tiktoks` ⊂ `tiktok essays` merges, while `LSAT prep` vs `LSAT application` (each has a word the
  other lacks) stays separate.
- Two guards now sit on top of subset containment. Both are worth re-probing every round:
  1. A one-word title made only of a **generic verb** never matches a longer goal. The list in
     `GENERIC_VERBS` is run, learn, quit, book, move, apply, call, write, read, plan, start, finish, buy,
     work, build, fix, send, study, practice, train, save, clean, email, meet, visit. So `#goals run`
     against `run a marathon` creates its own goal, but a one-word **noun** still merges
     (`#goals marathon` → `run a marathon`) — test both sides, or you only prove half the rule.
  2. Ambiguity: seed **two** live goals sharing a word (`photography portfolio`, `photography zine`), then
     send `#goals photography @friday`. It must become a **third** goal, and both originals must be
     byte-unchanged. Assert the goal **count** and each title/deadline in `goals.json`, not the reply.
- `mergeInto` is **additive only**: a deadline is filled in only when the existing goal has none (restating
  `#goals x @monday` over an `@friday` goal must keep **Friday**), and the title is replaced only when the
  incoming has **more significant words** — so `#goals the tiktok essays` (longer in characters, same words)
  must **not** rename `tiktok essays`. These two are the easiest regressions to reintroduce.
- Exception to the ambiguity rule: a title matching a candidate **word for word** wins even in a crowd, so
  texting the same goal twice still amends it rather than piling up duplicates. Probe with three goals
  (`cello practice`, `cello practice scales`, then `cello practice` again) — the third must merge into the
  first and leave the second alone.
- The composer surfaces the warning too: `public/app.js` reads `ambiguous` off the `POST /api/notes`
  response and shows `p#composerNotice` above the composer bar for 12s. Test it in **both** places — it was
  SMS-only at first, because the composer discarded the response body.
- Verify the good cases too, so the rule isn't dismissed wholesale: `tiktoks` + `tiktok essays` merging, and
  `call mum`/`call dad`, `learn piano`/`learn guitar`, `fix the bike`/`fix the sink` all staying separate.
- Quick offline sweep without the server (fastest way to map the rule before writing a plan):
  `node -e 'const g=require("./lib/goals"); console.log(g.sameGoal("run","run a marathon"))'`

### `@deadline` notation
- `#goals ship the essay @friday` — everything after the **last** `@` is the date phrase; if chrono can't
  parse it the whole line falls back to prose parsing, so `#goals email @priya about the referral` keeps
  `@priya` in the title with `deadline: null`, and `#goals ping @bob @friday` → title `ping @bob`, deadline
  Friday. Prose (`by December 1`, `on Sunday`) still works.
- Assert the **title string exactly** (no stray `@friday` left behind) as well as the pill date.

## #busy (time blocks + plan availability)
A **fourth store**: `$DATA_DIR/busy.json`, a day-keyed object `{"YYYY-MM-DD": [{id, start, end, label}]}`.
Seed/reset it as `{}` alongside notes.md/tags.json/goals.json, or `loadBusy()` starts from scratch.

- Routed as **rule 2** (after `#goals`, before `#create list`/`#todo`/`#done`) in both `routes/webhook.js`
  and `routes/api.js` `POST /notes`. Anchored by `BUSY_TAG = /^\s*(?:#\w+\s+)*#busy\b/i`, so
  `sorry I'm #busy today` stays a plain note (auto-tagged `busy`).
- Two syntaxes: a **range** (`9am-5pm work`), tried first via chrono in one pass; failing that a
  **start + length** (`3pm for 2 hrs dentist`). The duration regex is lifted out *before* chrono sees the
  text, because chrono reads "for 2 hrs" as a moment two hours in the **past**.
- `forwardDate` is deliberately **off**: a bare time is always **today**, even if already past. Test this
  by sending a time on the far side of the current clock (e.g. `#busy 6-7am gym` in the morning) and
  asserting the `busy.json` **key**, not the reply.
- Assert stored ISO instants are in the host TZ: under `TZ=America/New_York`, 9am serialises as
  `T13:00:00.000Z`. A `T09:00:00.000Z` means the TZ wiring is not reaching busy.js.
- Refusals must write **nothing** — always compare `md5sum busy.json` before/after, never just the reply.
- **Availability ≠ what the prompt lists.** `describeAvailability` prints the **raw, unclipped, unmerged**
  blocks, but the "That leaves Xh free" line uses clipped+merged math. So a `5-8am` block is *printed* as
  `5:00am–8:00am` yet only costs 1h of the 7am–11pm window. Assert the **free total**, via
  `plan.buildPrompt(plan.gatherContext(now))` — not the stored JSON, and not the printed block list.
- Plan generation targets **tomorrow**, so blocks must be logged for tomorrow's date to affect it.
- With zero blocks the prompt must stay byte-identical to before. Diff it against a `main` worktree:
  `git worktree add /tmp/mainco main && ln -s <repo>/node_modules /tmp/mainco/node_modules` (the worktree
  has no node_modules of its own, which otherwise fails with `Cannot find module 'chrono-node'`).
- Fully-booked short-circuits **before** `requestSuggestions`. Prove it costs nothing by setting
  `global.fetch = () => { throw new Error('NETWORK CALL ATTEMPTED') }` and confirming `generatePlan()`
  still *resolves* with `{fullyBooked: true, suggestions: []}`.
- **To see the fully-booked message in the dashboard you must set a key** — `POST /api/plan` returns 503
  on `!process.env.ANTHROPIC_API_KEY` *before* calling `generatePlan`, so with no key the UI shows
  "ANTHROPIC_API_KEY is not configured" and the fully-booked branch is unreachable. Use a deliberately
  **invalid dummy** key (`ANTHROPIC_API_KEY=sk-ant-INVALID-DUMMY...`): the short-circuit returns before any
  fetch, so no real request is possible. Only do this when the day really is fully booked.
- Both syntaxes cap a block at **16h** (`withinLimit`), the length of the planning window itself, so
  `7am-11pm` is the longest thing that parses. This exists because chrono resolves a reversed range by
  rolling the end onto tomorrow: `5pm-3pm` used to store a 22h block and quietly swallow a planning day.
  Regression cases: `#busy 5pm-3pm` and `#busy 9 to 5 work` (9am–5**am**, 20h) must be refused while
  `#busy 7am-11pm` and `#busy 9am 8 hours` are still accepted.
- `noon`/`midnight` are rewritten to `12pm`/`12am` before chrono parses, because chrono reads `noon to 1pm`
  but takes `noon-1pm` for a stray `-1` and returns a 1pm instant with no end. Probe `noon-1pm`,
  `11am-noon`, `midnight-6am` and `noon for 1.5 hours` — all four should parse.

## Routing rules worth probing
`#goals ...` (rule 1) · `#busy <range|start+length>` (rule 2) · `#create list <Name>` + newline items ·
`#todo <item>` (per-calendar-day list) ·
`#done <what you finished>` · `<item> #existingtag` (appends to an existing list only) ·
anything else = plain auto-tagged note. Rule *order* matters — when a new rule is added, re-test that a
message carrying two special tags lands in the intended branch.
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

## Checklist check-off (ticking list items)
- `PATCH /api/notes/:id/items/:itemIndex?dateTime=<entry dateTime>` with `{}` to toggle or `{"done":bool}`
  to set. `id` is the entry's position in notes.md; `itemIndex` counts **checkbox lines only** within that
  entry, so a prose line sitting between two checkboxes does not consume an index.
- Three clickable surfaces, all rendering `button.item.checkable[data-item=<checkIndex>]`: the feed card,
  the detail view (`#detailItems`) and the Today column (`#todayItems`). Non-checkbox body lines render as
  a plain `div.item` with **no** `data-item`, so they are not clickable — a good DOM-level check.
- On a feed card the click handler order is `[data-delete]` → `[data-item]` → `showDetail`, so clicking an
  item must tick it and *not* navigate; clicking the card title/blank area must still open the detail view.
  Test both, or a regression where items swallow all card clicks would go unnoticed.
- Toggling reloads the feed rather than patching the DOM, and re-runs `showDetail` if a detail view is open,
  so the detail view should stay open after a tick.
- **Build the fixture so a broken implementation looks different.** A list with only plain checkboxes proves
  almost nothing. Use: a guard note at file id 0 (so no list is at id 0 — catches off-by-one id addressing),
  a non-checkbox prose line *between* two checkboxes (catches counting body lines instead of checkbox lines),
  one item that starts pre-checked (`- [x]`, lets you prove untick), and a second untouched list (proves no
  cross-entry damage). Then tick the checkbox *after* the prose line and diff.
- Verify byte-exactly: `sed 's/^- \[ \] bread$/- [x] bread/' seed.md > expected.md && diff expected.md notes.md`.
  A correct toggle changes exactly one character.
- Error paths, all of which must leave the file byte-unchanged: out-of-range `itemIndex` → 404, mismatched
  `?dateTime=` → 404, negative/non-numeric index → 400, non-boolean `done` → 400, unauthenticated → 401,
  and an index against a plain (non-list) note → 404.

## #done (fuzzy cross-off of today's todo list)
- `lib/done.js`. `markDone(text)` scores each checkbox item on today's list by keyword overlap and either
  ticks the best match via `notes.setItemDone`, or — when nothing is confident enough — appends the text to
  today's list **already crossed off** via `notes.addToDailyTodo(item, true)`, creating the day's list if it
  doesn't exist yet. `createList`/`addItemToList`/`addToDailyTodo` take an optional trailing `done` param.
- Matching internals you must model to write non-guessy tests: text is lowercased, punctuation stripped,
  stopwords dropped (they include `went, for, a, the, my, done, today, got, go, out, off, all` — so
  `#done went for a walk` reduces to just `{walk}`), then crudely stemmed (`ied→y`, strip `ing|ed`, `ies→y`,
  strip trailing `s`), and 1-char tokens are dropped. Confidence = **score ≥ 2**, or score == 1 only when
  `min(needle.size, item.size) === 1` (that's what makes `#done dishes` match `- [ ] dishes`). Ties prefer an
  **unfinished** item.
- **Compute the expected scores with the real module before writing the plan** rather than guessing:
  `node -e 'const d=require("./lib/done"); console.log([...d.keywords("emailed professor")])'`. `keywords` is
  exported precisely for this.
- The false-positive probe is the test that actually earns trust: pick a message sharing exactly **one**
  non-stopword with a list item where both sides have ≥2 keywords (e.g. item
  `email professor about recommendation letter` vs `#done letter from the landlord`). It must NOT tick.
  Run it **while the target item is still `- [ ]`** — if you run it after the item is already crossed off, a
  wrong match is invisible and the test proves nothing.
- To test "creates the day's list" honestly, the fixture must have **no** `Todo <today>` entry. Confirm with
  `curl -u loci:testpass localhost:PORT/api/todos/today` → `{"entry":null}` before starting.
- Replies: match → `Crossed off "<item text>".`; no match → `Nothing on today's list matched, so "<text>" was
  added as done.`; bare `#done` → `Send "#done" followed by what you finished.` and **nothing is written**
  (assert via md5). Bare `#done` through the composer returns 400 `tell me what you finished`, but the client
  ignores non-OK responses, so the user sees no error — known nit, not a regression.
- Anchored `/^#done\b/i`, so `I am all #done with this` stays a plain note (it gets auto-tagged `done`).
- A `#done` whose words are *all* stopwords still appends (needle is empty → no match → append), e.g.
  `#done it is all done today`. Harmless, but don't be surprised by it.
- The stemmer is crude and regular-verb only: `watered`→`water` matches, but **irregular pasts do not**
  (`swept` does not stem to `sweep`, so `#done swept the porch` will NOT match `- [ ] sweep the porch` and
  appends instead). Pick regular verbs when you *want* a match, or you'll misdiagnose correct code as broken.
- Items that `#done` wrote are ordinary `- [x]` lines, so PR #5's click-to-toggle must still work on them —
  worth clicking one in the Today column to prove the checkbox index is right with `- [x]` lines interleaved.

## Per-line todo items and legacy "broken" lists
- `notes.todoItems(text)` splits a `#todo` body on newlines and strips a leading `-`/`*` and any `[ ]`/`[x]`
  the sender typed, so each line becomes its own `- [ ]`. Probe it with a message mixing styles, e.g.
  `#todo\nbuy milk\n- call the dentist\n* [ ] pick up prescription` → exactly three `- [ ] …` lines, no
  doubled `- [ ] - [ ]`, and **no new entry** (it appends to the existing day list). Webhook only — the
  dashboard composer is a single-line `<input>`, so test single-line parity there.
- **Every non-empty body line of a `List:` entry is an item**, checkbox or not, and the three places that
  index items must agree: `public/app.js` `shapeEntry` (gives every line a `checkIndex`), `notes.setItemDone`
  (`isItemLine`, skipping `##`/`Tags:`/`---`) and `lib/done.js` `checkboxItems`. Ticking a bare line rewrites
  it in place as `- [x] text`.
- **Fixture that actually exposes a broken index**: make the legacy list *today's* list and interleave the
  two kinds of line, with a bare line both between and after checkboxes, plus one pre-checked row:
  ```
  - [ ] renew library card                       <- item 0
  drop off dry cleaning                          <- item 1 (BARE)
  - [x] water the plants                         <- item 2
  email professor about recommendation letter    <- item 3 (BARE)
  ```
- The load-bearing test is the **alignment retest**: tick the bare item 1 (it gains a checkbox), *then* tick
  item 2. A server still counting checkbox-only lines resolves UI index 2 to the wrong row, so a neighbour
  flips instead. Ticking only one row and calling it a day proves nothing.
- `#done` must be able to cross off a **bare** legacy line in place; the pre-fix bug was appending a
  duplicate because the matcher only saw checkbox lines. Assert `grep -c '<word>' notes.md == 1`.
- Bare-line rewriting is gated on the entry being a `List:`. A plain `— Note` must never become a checklist:
  `PATCH /api/notes/<note id>/items/0` → **404** *and* `md5sum notes.md` unchanged. Check both; the 404 alone
  doesn't prove the file wasn't touched.

## Timezone / day scoping
- `lib/notes.js` `timestamp()` uses `Date` **local getters**, so `today()`, `dailyTodoName()` (`Todo
  YYYY-MM-DD`), entry timestamps and `PLAN_SEND_TIME` all follow the host `TZ` env var. Nothing in the app
  reads a timezone from config — `TZ` in `fly.toml` is purely a host setting, so it is verifiable locally.
- To prove day-scoping rather than assert it, run **two servers with different `TZ` and different DATA_DIRs**
  while the box clock sits inside the offset window (check `date -u` vs `TZ=America/New_York date`), and post
  the same `#todo` to each. Late evening Eastern gives `Todo <today>` on the NY server and `Todo <tomorrow>`
  on the UTC server — a visible difference, not a simulation. Never claim deployed behaviour from this.
- Gotcha: goal cards render `created_at` **client-side** in the *browser's* timezone (`public/app.js` uses
  `new Date(goal.created_at)` on an ISO string), while note stamps are formatted server-side in the host TZ.
  Near the boundary a goal card can read "Aug 10" while notes written the same second read "Aug 9". Expect
  it; don't file it as a per-line/`#done` regression.

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

## Busy tab (week view) and planning any day
Since the Busy-tab PR the read-only Busy list is **no longer in the Today sidebar** — it is a third tab next
to Notes and Goals, and the plan button moved to the **Goals** tab.

- `GET /api/busy?from=YYYY-MM-DD&days=N` (N 1-60, integer) returns `{from, days:[{date, blocks}], ...day0}`;
  the old single-day shape is spread on top for older callers. Validation to probe: `days=0`, `days=61`,
  `days=abc` → `{"error":"days must be 1-60"}`; a malformed `from` → `date must be YYYY-MM-DD`.
- The tab renders **7 days including empty ones** (`div.week-day.free` + `div.week-free` "Open"), headed
  `Today` / `Tomorrow` / weekday name. `dayHeading` parses at `T12:00:00`, so a TZ bug shows up as a wrong
  weekday, and a UTC-vs-Eastern bug shows as times shifted 4-5h (`9:00am-5:00pm` rendering `1:00pm-9:00pm`).
- Each block has a **hover-revealed** `button.busy-delete` `×` (`data-date`, `data-block`) behind a native
  `window.confirm`. Test the **Cancel** branch too, and reload after deleting — `removeBlock` deletes the
  whole day key when its last block goes, so check `busy.json` no longer has that date while neighbours live.
- Planning: the Goals tab has `input#planDate` (defaults to **tomorrow**, `min` = today) + `Make a plan`,
  posting `{date}` to `POST /api/plan`. `plan.gatherContext(now, planDate)` keys everything off it.
- Date validation happens **before** the API-key check, so `{"date":"garbage"}` → 400 `date must be
  YYYY-MM-DD` and a past date → 400 `that day has already been and gone` are both reachable **keyless**.
- To prove the picker really changes the planned day (not just that a date input exists), make **one** day
  fully booked (`#busy <weekday> 7am-11pm x`) and leave another partly free, then click Make a plan on each:
  the booked day must print `No open time on <that date> — ...` naming the date you chose, and the free day
  must take a visibly different branch. A build ignoring `planDate` prints the same thing both times.
  That needs a key to clear the 503 — use the **invalid dummy key** trick below, and confirm in the server
  log that only the free day produced a `Claude API 401`, i.e. the booked day never called out.
- Logging a block for a specific future date works in **both** positions for the *range* syntax: a leading
  day word (`#busy thursday 7am-11pm conference`) and a trailing date (`#busy 7am-11pm conference on
  2026-08-13`, `#busy 9am-5pm standup on thursday`). `moveToStatedDay` in `lib/busy.js` scans the leftover
  text for a chrono result certain about day/weekday, shifts by whole calendar days and drops the phrase
  from the label. Assert the `busy.json` **key** *and* the resulting label.
- **Both branches** call `moveToStatedDay` now, so `#busy 3pm for 1 hr jog on 2026-08-15` and
  `#busy 3pm-4pm walk on 2026-08-15` both land on Aug 15. It was range-only once, so always send the same
  trailing date in *both* syntaxes and compare — that side-by-side in the Busy week is the clearest
  possible evidence, and the duration branch is the one that regresses.
- Adversarial label case worth keeping: `#busy 9am-5pm dinner with may on friday` must land on Friday with
  the label `dinner with may` — the month-name `may` inside the intended label must survive.
- A **named weekday** landing in the past is pushed on a week by `forwardWeekday`, in both positions:
  `#busy 10am-11am retro on monday` sent on a Tuesday books the *coming* Monday. Bare times keep
  `forwardDate:false`, so `#busy 7-8pm dinner` sent at 8pm is still tonight — test both, they pull in
  opposite directions. An unparseable date (`on 2026-08-99`) still falls back to today with the text left
  in the label.

## Frontend notes
- Feed polls every 15s but is suppressed while a detail view is open (`selectedIndex !== null`) **or a goal
  is being edited** (`editingGoal !== null`) — to test, open a card, inject a note via the webhook, wait
  >20s, and confirm the detail view didn't change.
- Today's todo list is hidden from the plain feed but must still appear in search and tag-filter results.
- Layout breakpoint at 900px: resize with `wmctrl -r :ACTIVE: -e 0,0,0,700,760` (and re-maximize with
  `wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`) rather than devtools.
- The dashboard caches nothing, but if you restart the server with new data the open tab may show stale
  tags/entries for up to 15s — press F5.
- Cards are `div[role=button][tabindex=0]` with a keydown handler, not `<button>`. Keyboard check: Tab from
  the search box reaches a card (visible focus ring), Enter and Space both open the detail view; Tab order
  then goes into that card's `×`, so shift+Tab back to the card before pressing Space.

## Watch out: checking out a feature branch can stash this skill file
The skill lives in `.agents/skills/` but is deliberately kept **out of the feature branches**, so a
`git stash -u` before `git checkout <branch>` sweeps it (and any test plans/reports) into the stash and it
vanishes from the working tree mid-session. Recover it without disturbing the branch with:
`git checkout 'stash@{0}^3' -- .agents/skills/testing-loci/SKILL.md` (`^3` is the untracked-files commit of
the stash). Check `git stash show -p 'stash@{0}' --include-untracked --name-only` to see what was swept.

## The webhook is rate limited — space your sends
`routes/webhook.js` wraps `/webhook/sms` in a **60s-window** `rateLimit`. A tight loop seeding fixtures
replies `Too many requests` and writes nothing, which looks exactly like a parser refusal. Sleep ~6s
between sends when scripting a batch, and if a whole batch comes back `Too many requests`, wait out the
full minute before retrying. Seeding via `POST /api/notes` (`curl -u loci:testpass`) is not rate limited.

## curl gotcha for multi-line webhook bodies
`--data-urlencode @file` sends the file as the **whole body with no field name**, so the server sees an
empty `Body` and replies "Got an empty message". Use `--data-urlencode "Body@/tmp/body.txt"` (field name,
then `@`) when the message needs real newlines.

## Devin Secrets Needed
None for local testing. `DASHBOARD_PASSWORD` can be set to any throwaway value (e.g. `testpass`) to exercise
the login gate. The real production vars (`TWILIO_AUTH_TOKEN`, `PUBLIC_URL`, the real dashboard password) are
not required and should not be used locally.
