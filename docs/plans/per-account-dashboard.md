# Per-account dashboard access

## Context

loci lets any phone number link its own Google Drive via the claim flow
(`routes/claim.js`) — once linked, that number's texts are saved to a
`Loci` folder in *their own* Drive instead of the owner's local disk
(`lib/accounts/resolveSender.js` routes each inbound SMS sender to the
right storage). But there is no way for that person to view their notes
on the web: the dashboard (`/`, gated by `requireAuth` in `lib/auth.js`)
is single-tenant today — whoever logs in always sees `ownerStores`
(the owner's local-disk data), regardless of which credentials they used.
There is currently no concept of "which account" anywhere in the
auth/session layer; every valid session is fully interchangeable.

Goal: give each claimed, active, Drive-linked account its own scoped
dashboard view, reachable by logging in with an OTP sent to their own
phone number. Claiming Drive access and getting dashboard access are the
same step — no manual per-account allowlisting.

## Decisions already made (do not re-litigate)

1. **Automatic access.** Any phone number with an active claimed account
   (status `active`, has `encrypted_refresh_token`) can request an OTP and
   log in — no separate opt-in flag.
2. **`LOGIN_PHONE_NUMBERS` stays, as a union.** Keep it working for
   deployments that already use it (e.g. admin numbers that aren't the
   owner and haven't claimed anything) — the allowed set becomes
   `{owner} ∪ {LOGIN_PHONE_NUMBERS entries} ∪ {active claimed accounts}`,
   and legacy/admin numbers map to the owner view (today's only
   behavior — no regression).
3. **Session must encode identity.** `role: 'owner' | 'account'`, and for
   accounts an `accountId`. Sign with the existing `DASHBOARD_PASSWORD` —
   no new secret/env var.
4. **This is a session token format change.** Old outstanding sessions
   won't parse under the new scheme. Everyone (owner included) will need
   to log in again once this ships — expected, one-time, not a bug to
   work around.
5. **Scripted/header auth has no phone to derive identity from** —
   `x-dashboard-secret` and basic auth (`lib/auth.js`'s
   `credentialsMatch` path) map to `role: 'owner'`, matching today's only
   behavior.
6. **"Send my plan via text" is owner-only, permanently.** Claimed
   accounts' raw phone numbers are never stored — only an HMAC
   (`hashPhone` in `lib/phone.js`; see the comment at
   `routes/claim.js:12-14`) — so there is no number to text a generated
   plan back to. Plan *generation/viewing* should still work per-account;
   only the "send by text" action is owner-gated.
7. **The nightly plan scheduler stays owner-only.** Out of scope — don't
   touch `lib/plan.js`'s scheduler or `PLAN_PHONE_NUMBER`.

## Design

### 1. `lib/auth.js` — session format

Current: cookie is `${issuedAt}.${signature}`, where
`signature = HMAC(DASHBOARD_PASSWORD, "${expectedUser()}.${issuedAt}")`.
`validSession()` returns a boolean; `isAuthenticated()` returns a boolean.

New: cookie becomes `${issuedAt}.${role}.${ref}.${signature}`, where
`ref` is empty for `role=owner` or the account's numeric `id` for
`role=account`, and `signature` covers all of
`${expectedUser()}.${issuedAt}.${role}.${ref}`.

- `issueSession(password, identity)` — `identity` is
  `{ role: 'owner' }` or `{ role: 'account', accountId }`.
- Replace `validSession(token, password): boolean` with a
  `parseSession(token, password): identity | null` that verifies the
  signature and TTL and returns the parsed identity (or null).
- `setSessionCookie(res, password, identity)` — takes identity now.
- `isAuthenticated(req)` — keep as a boolean convenience
  (`Boolean(getIdentity(req))`) for the few places that only need a
  yes/no (e.g. the `/login` GET redirect-if-already-in check).
- Add `getIdentity(req)` — cookie path returns the parsed identity;
  header/basic-auth fallback paths (unchanged conditions) return
  `{ role: 'owner' }`.
- `requireAuth` — on success, set `req.lociIdentity = identity` before
  calling `next()`, so downstream middleware/routes can read it.

### 2. Phone → login identity resolution

New helper, mirroring `lib/accounts/resolveSender.js`'s shape — put it
next to it, e.g. `lib/accounts/resolveLogin.js`:

```
resolveLoginIdentity({ phone, accountRepo, ownerPhone, loginPhoneNumbers })
```

- Normalize `phone` (`normalizePhone` from `lib/phone.js`).
- If it matches `ownerPhone` → `{ role: 'owner' }`.
- Else if it's in `loginPhoneNumbers` (the existing
  `LOGIN_PHONE_NUMBERS` list) → `{ role: 'owner' }` (legacy admins get
  the owner view, same as today).
- Else hash it (`hashPhone`) and look up `accountRepo.findByPhoneHash`;
  if `status === 'active'` and it has `encrypted_refresh_token` →
  `{ role: 'account', accountId: account.id }`.
- Else → `null` (not allowed).

Wire into `server.js`:

- `POST /login/otp/start` — replace `otp.isAllowed(phone)` with
  `resolveLoginIdentity(...)`. Keep the existing enumeration-safety
  behavior: respond `{ok:true}` either way, only call `otp.sendCode`
  when an identity resolves.
- `POST /login/otp/check` — recompute `resolveLoginIdentity(...)`
  server-side (don't trust anything client-supplied) after
  `otp.checkCode` succeeds, then
  `setSessionCookie(res, process.env.DASHBOARD_PASSWORD || '', identity)`.
- `lib/otp.js`'s `otpEnabled()` should stop depending on
  `allowedPhones().length` — availability of the *feature* is just
  "Twilio Verify is configured"; *who* is allowed is
  `resolveLoginIdentity`'s job now. Keep `lib/otp.js` itself as pure
  Twilio Verify mechanics (send/check/normalize) — no accountRepo
  dependency belongs in there.

### 3. Shared "build stores from an account" helper

`resolveSender.js` already inlines: decrypt token
(`lib/tokenCrypto.js`'s `decryptToken`) → construct
`new GoogleDriveProvider({ clientId, clientSecret, refreshToken, folderId })`
(`lib/storage/GoogleDriveProvider.js`) → `buildStores(provider)`
(`lib/stores.js`). Extract this into a small shared helper, e.g.
`lib/accounts/buildAccountStores.js` exporting
`buildAccountStores(account)`, and use it from both `resolveSender.js`
and the new dashboard middleware below — avoids duplicating the same
five lines in two places.

### 4. Dashboard store-resolution middleware

New middleware, mounted in `server.js` right after `requireAuth` for the
`/api` mount only (static file serving doesn't need stores):

```
app.use('/api', requireAuth, resolveDashboardStores(accountRepo, ownerStores), createApiRouter({ sms }))
```

`resolveDashboardStores`:
- `role === 'owner'` → `req.stores = ownerStores`; `req.plan = plan`
  (the existing owner-bound `plan` instance from `server.js`).
- `role === 'account'` → re-fetch `accountRepo.findById(accountId)` (do
  **not** trust anything cached from login time — re-check `status`
  and `encrypted_refresh_token` on every request, so revoking an
  account immediately cuts dashboard access too). If no longer valid →
  clear the session cookie and `401`. Otherwise
  `req.stores = buildAccountStores(account)` and
  `req.plan = createPlanModule(req.stores)` — cheap, `lib/plan.js`'s
  factory just closes over stores at construction, no I/O
  (`lib/plan.js:191`).

### 5. `routes/api.js` refactor

Today `createApiRouter(stores, { plan, sms })` destructures
`{ notes, tags, goals, busy, done }` from `stores` **once**, at factory
construction (`routes/api.js:3-4`), and every handler closes over those
fixed variables. Change the factory to `createApiRouter({ sms })` (no
`stores`/`plan` params), and change each handler to read
`req.stores`/`req.plan` at the top of its own callback instead of the
closed-over variables. Mechanical, touches every handler in the file —
describe the pattern once when implementing, no need to plan each
handler individually.

For `/api/plan`'s send-by-text branch (`routes/api.js:~210-213`, uses
`sms.canSend(process.env.PLAN_PHONE_NUMBER)` /
`sms.sendMessage(process.env.PLAN_PHONE_NUMBER, ...)`): gate it on
`req.lociIdentity.role === 'owner'` — return an error (or just ignore
`req.body.send`) for account sessions, since there is no phone number to
send to for a claimed account (see decision #6).

### 6. Front-end: knowing which role is active

Add `GET /api/whoami` → `{ role, accountId? }` (reads `req.lociIdentity`,
no stores needed). `public/app.js` fetches it once on load and:
- hides/disables the "send via text" control in the plan UI when
  `role !== 'owner'`.
- (nice-to-have, not required) shows a small "Signed in as Owner" /
  "Signed in as your account" hint somewhere in the new menu-panel
  (`public/index.html`'s `#menuPanel`) for clarity.

No changes needed to `public/login.html` — its phone/password tab logic
is already generic and identity-agnostic.

## Tests

No existing test file covers `lib/auth.js`, `lib/otp.js`, or
`routes/api.js` — this is net-new coverage, following
`test/claim.test.js`'s pattern (bare `express()` app + only the
router(s) under test, `http.createServer`, `listen(0)`, hand-rolled
`http.request` helpers, assert status/body/headers, `server.close()` in
`afterEach`).

- `test/auth.test.js` — session issue/parse round trip for both
  identities, tampered-signature rejection, expired-token rejection,
  and that an old-format (pre-change) token fails to parse rather than
  silently mapping to some default identity.
- `test/resolveLogin.test.js` — mirrors `test/resolveSender.test.js`:
  owner phone → owner identity, `LOGIN_PHONE_NUMBERS` entry → owner
  identity, active claimed account → account identity, inactive/no-token
  account → null, unknown number → null.
- `test/api.test.js` (new) — mount `/login` + `/api` together against a
  real `UserAccountRepository(':memory:')`. Cover: owner login →
  `/api/notes` reflects `ownerStores`; an active claimed account (insert
  directly via the repo, mint its session via the exported
  `issueSession`/`setSessionCookie` helpers rather than driving real
  Twilio/Google) → `/api/notes` reflects its own Drive-backed store,
  isolated with a stub Drive client (same injection pattern already
  added to `routes/claim.js` — `createClaimRouter(userRepo,
  createOAuth2Client)` — extend `resolveDashboardStores`/
  `buildAccountStores` similarly so a stub provider can be injected in
  tests); revoking an account (set `status` to something else) 401s a
  previously-valid session on its very next `/api` request.

## Docs

- `README.md`'s `LOGIN_PHONE_NUMBERS` section — currently documents it
  as the *only* dashboard allowlist; update to describe the new
  automatic-for-claimed-accounts behavior and that this list is now
  supplementary (admins/legacy), not exhaustive.
- `.env.example` — matching comment update near `LOGIN_PHONE_NUMBERS`.

## Suggested order

1. `lib/auth.js` session format change (self-contained, testable in
   isolation).
2. `lib/accounts/buildAccountStores.js` extraction + swap
   `resolveSender.js` to use it (pure refactor, existing tests should
   still pass unchanged).
3. `lib/accounts/resolveLogin.js` + wire into `/login/otp/start` and
   `/login/otp/check` in `server.js`.
4. `resolveDashboardStores` middleware + `routes/api.js` refactor to
   `req.stores`/`req.plan` + `/api/whoami`.
5. Front-end: hide send-by-text for non-owner role.
6. Tests (can start alongside step 1, finish after step 4).
7. Docs.

## Verification

- `npm test` — full suite green, including the new files above.
- Manual: claim a test number end-to-end (`/claim/google/start` →
  callback), then hit `/login/otp/start` + `/login/otp/check` for that
  same number, confirm `/api/notes` returns only notes written by that
  number's texts — not the owner's — and that the plan UI's send-by-text
  control is absent.
- Manual: log in as owner, confirm nothing regresses (notes, goals,
  busy, plan generation *and* send-by-text all still work).
- Confirm a pre-existing session cookie (captured before this change)
  is rejected and redirects to `/login` rather than 500ing or silently
  granting owner access.
