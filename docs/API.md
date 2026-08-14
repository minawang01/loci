# Loci API Reference

This document describes the HTTP endpoints, OAuth claim flow, and environment variables used by the Loci app.

**Claim / OAuth**
- POST /claim/request
  - Description: Create a one-time claim token for a phone number. The number is normalized and hashed server-side (HMAC-SHA256, `ACCOUNT_HASH_SECRET`) before it touches the database — the raw number is never stored.
  - Body: { "phone": "+15551234567" }
  - Response: { "ok": true, "token": "<short-token>", "url": "<claim url>", "expires_at": "<ISO date>" }

- POST /claim/complete
  - Description: Validate and consume a claim token to attach an account. Used for non-OAuth / manual completion; the OAuth flow below is the normal path. A plaintext `refresh_token`, if given, is encrypted (`TOKEN_ENCRYPTION_KEY`) before being stored.
  - Body: { "token": "<token>", "storage_provider": "google_drive", "provider_folder_id": "<optional>", "refresh_token": "<optional plaintext>" }
  - Response: { "ok": true }

- GET /claim/google/start?token=<token>
  - Description: Redirects the browser to Google's OAuth consent page (`drive.file` scope). `token` is passed in the OAuth `state` param so the callback can associate the response with the claim.

- GET /claim/google/callback?code=...&state=<token>
  - Description: OAuth callback endpoint. Exchanges the code for tokens, encrypts the refresh token, stores it on the `user_accounts` row, and marks the account as claimed.

**Other HTTP routes**
- POST /webhook/sms
  - Description: Twilio webhook for incoming SMS/WhatsApp messages. The sender's number (Twilio's `From` field) is resolved to a storage destination by [lib/accounts/resolveSender.js](../lib/accounts/resolveSender.js):
    - `OWNER_PHONE_NUMBER` always reads/writes local disk.
    - A number linked to an active account with a stored refresh token gets its own stores, built fresh per request against its linked Google Drive folder.
    - Any other number gets a reply with a claim link (the same link is reused until it's claimed or expires) and nothing is saved.
  - Note: See [routes/webhook.js](../routes/webhook.js) for the message-parsing rules once a sender is resolved.

- GET/POST /api/*
  - Description: Dashboard API, gated by `DASHBOARD_PASSWORD`. Which storage it reads/writes depends on the session: the owner (and the scripted `x-dashboard-secret`/basic-auth paths) get local disk, while a session signed in with a claimed account's number gets that account's own Drive-backed stores. [lib/accounts/resolveDashboardStores.js](../lib/accounts/resolveDashboardStores.js) re-checks the account on every request and sets `req.stores`/`req.plan` for the handlers.
  - Note: See [routes/api.js](../routes/api.js) for the full endpoint list.

- GET /api/whoami
  - Description: The identity behind the current session, so the dashboard can say which storage it is showing.
  - Response: { "role": "owner" } or { "role": "account", "accountId": 3 }

- POST /login/otp/start, POST /login/otp/check
  - Description: Phone sign-in. A number may sign in if it is `OWNER_PHONE_NUMBER`, is listed in `LOGIN_PHONE_NUMBERS` (both of which get the owner's dashboard), or has an active claimed account (which gets its own scoped dashboard) — see [lib/accounts/resolveLogin.js](../lib/accounts/resolveLogin.js). Numbers that may not sign in get the same response and no text.

**Storage providers**
- The app uses a pluggable async storage abstraction in `lib/storage` (`readFile`/`writeFile`/`listFiles`/`deleteFile`/`ensureDataDir`, see `lib/storage/StorageProvider.js`).
  - Local: `lib/storage/LocalFileStorageProvider.js` — used once, for the owner.
  - Google Drive: `lib/storage/GoogleDriveProvider.js` — one instance per linked account, scoped to that account's Drive folder (`provider_folder_id`). Files are plain-text (not native Google Docs).
- `lib/notes.js`, `lib/tags.js`, `lib/goals.js`, `lib/busy.js`, `lib/done.js` are factories (`createXStore(storageProvider)`) rather than singletons, so a fresh set of stores can be built per account. `lib/stores.js`'s `buildStores(storageProvider)` builds the full `{ notes, tags, goals, busy, done }` bundle.

**Database schema**
- `user_accounts` table (managed by `lib/accounts/UserAccountRepository.js`)
  - id, phone_number_hash, storage_provider, encrypted_refresh_token, provider_folder_id, claimed_at, last_active_at, status
- `claim_tokens` table
  - token, phone_number_hash, expires_at

**Environment variables**
- `OWNER_PHONE_NUMBER` — the number that keeps using local disk; required in production
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — required for Google OAuth (anyone other than the owner claiming an account)
- `ACCOUNT_HASH_SECRET` — HMAC key phone numbers are hashed with before storage
- `TOKEN_ENCRYPTION_KEY` — AES-256 key (base64, 32 bytes) refresh tokens are encrypted with at rest
- `PUBLIC_URL` — base URL used for OAuth redirect URIs and claim links
- `DATA_DIR` — local storage directory for `LocalFileStorageProvider` (owner only)
- `ACCOUNTS_DB` — path to SQLite DB file (default `./data/accounts.db`)
- `DASHBOARD_PASSWORD` — simple password guard for the admin dashboard

**Examples**
- Create a claim token (curl):

  curl -X POST -H "Content-Type: application/json" -d '{"phone":"+15551234567"}' https://example.com/claim/request

- Start OAuth in-browser:
  Open: https://example.com/claim/google/start?token=<token>

**Testing**
- Run unit tests with:

  npm test

For implementation details, see the source files referenced above.
