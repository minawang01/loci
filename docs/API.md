# Loci API Reference

This document describes the HTTP endpoints, OAuth claim flow, and environment variables used by the Loci app.

**Claim / OAuth**
- POST /claim/request
  - Description: Create a one-time claim token for a phone number. Used when a user initiates account linking.
  - Body: { "phone": "+15551234567" }
  - Response: { "token": "<short-token>" }

- POST /claim/complete
  - Description: Validate and consume a claim token to attach an account. Typically called by the server after OAuth completes or by the UI when the token is presented.
  - Body: { "token": "<token>", "accountId": "<optional>" }
  - Response: { "ok": true }

- GET /claim/google/start?token=<token>
  - Description: Redirects the browser to Google's OAuth consent page. `token` is passed in the OAuth `state` param so the callback can associate the response with the claim.

- GET /claim/google/callback?code=...&state=<token>
  - Description: OAuth callback endpoint. Exchanges the code for tokens, stores the refresh token on the `user_accounts` row, and marks the account as claimed.

**Other HTTP routes**
- POST /webhook/sms
  - Description: Twilio webhook for incoming SMS messages. Messages are routed to the account associated with the phone hash.
  - Note: See [routes/webhook.js](routes/webhook.js) for routing logic.

- GET/POST /api/*
  - Note: Additional API actions are implemented in [routes/api.js](routes/api.js). Use that file for details.

**Storage providers**
- The app uses a pluggable storage abstraction in `lib/storage`.
  - Local: `lib/storage/LocalFileStorageProvider.js` (default)
  - Google Drive: `lib/storage/GoogleDriveProvider.js` (per-account Drive folder)

**Database schema**
- `user_accounts` table (managed by `lib/accounts/UserAccountRepository.js`)
  - id, phone_hash, google_refresh_token (stored in `encrypted_refresh_token` column in db), created_at, updated_at
- `claim_tokens` table
  - token, account_id, phone_hash, expires_at

**Environment variables**
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — required for Google OAuth
- `PUBLIC_URL` — base URL used for OAuth redirect URIs
- `DATA_DIR` — local storage directory for `LocalFileStorageProvider`
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

**Next steps / TODO**
- Add encrypted storage for refresh tokens (server-side KMS or environment secret).
- Harden OAuth callback handling when Google omits `refresh_token` (re-prompt or surface UI instructions).
- Add per-account folder lookup/creation resilience and pagination handling for Drive API calls.

For implementation details, see the source files referenced above.
