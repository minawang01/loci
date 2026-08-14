const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { normalizePhone, hashPhone } = require('../lib/phone');
const { encryptToken } = require('../lib/tokenCrypto');

// Factory to allow injecting a repo (and, for tests, a stub OAuth2 client) —
// real usage always omits `createOAuth2Client` and gets the googleapis one.
function createClaimRouter(userRepo, createOAuth2Client) {
  const repo = userRepo;
  const buildOAuth2Client = createOAuth2Client
    || ((clientId, clientSecret, redirectUri) => new google.auth.OAuth2(clientId, clientSecret, redirectUri));
  const router = express.Router();

  // Request a claim token for a phone number. The number itself is never
  // stored — only its HMAC hash — so the webhook can look accounts up the
  // same way from Twilio's `From` field.
  router.post('/request', (req, res) => {
    if (!process.env.ACCOUNT_HASH_SECRET) return res.status(503).json({ error: 'claiming is not configured' });
    const normalized = normalizePhone(req.body.phone);
    if (!normalized) return res.status(400).json({ error: 'a valid phone number is required' });
    const phoneHash = hashPhone(normalized);
    const token = crypto.randomBytes(18).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
    repo.createClaimToken(token, phoneHash, expiresAt);
    const url = `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/claim.html?token=${token}`;
    res.json({ ok: true, token, url, expires_at: expiresAt });
  });

  // Complete claim: attach provider info to account. Used for non-OAuth /
  // manual completion; the OAuth callback below handles the real Google flow.
  // A plaintext `refresh_token`, if given, is encrypted before it touches the
  // database — the client never sends (or needs to know) the encrypted form.
  router.post('/complete', (req, res) => {
    const { token, storage_provider = 'google_drive', provider_folder_id = null, refresh_token = null } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    if (refresh_token && !process.env.TOKEN_ENCRYPTION_KEY) {
      return res.status(503).json({ error: 'token encryption is not configured' });
    }
    const record = repo.findClaimToken(token);
    if (!record) return res.status(404).json({ error: 'token not found' });
    if (new Date(record.expires_at) < new Date()) return res.status(410).json({ error: 'token expired' });

    const encrypted_refresh_token = refresh_token ? encryptToken(refresh_token) : null;

    // Create or update account
    const existing = repo.findByPhoneHash(record.phone_number_hash);
    if (existing) {
      repo.updateAccount(existing.id, {
        storage_provider,
        provider_folder_id,
        encrypted_refresh_token,
        claimed_at: new Date().toISOString(),
        status: 'active'
      });
    } else {
      repo.createAccount({
        phone_number_hash: record.phone_number_hash,
        storage_provider,
        provider_folder_id,
        encrypted_refresh_token,
        claimed_at: new Date().toISOString(),
        last_active_at: null,
        status: 'active'
      });
    }

    repo.deleteClaimToken(token);
    res.json({ ok: true });
  });

  // Start Google OAuth for a claim. Accepts `token` as state to link back.
  router.get('/google/start', (req, res) => {
    const { token } = req.query;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const publicUrl = process.env.PUBLIC_URL || '';
    if (!clientId || !clientSecret) return res.status(500).send('OAuth not configured');
    const redirectUri = `${publicUrl.replace(/\/$/, '')}/claim/google/callback`;
    const oauth2Client = buildOAuth2Client(clientId, clientSecret, redirectUri);
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/drive.file'],
      state: token || ''
    });
    res.redirect(url);
  });

  // OAuth callback: exchange code for tokens and complete the claim
  router.get('/google/callback', async (req, res) => {
    const { code, state: token } = req.query;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const publicUrl = process.env.PUBLIC_URL || '';
    // Genuine server misconfiguration — an operator issue, not a user-facing
    // one, so this stays a plain response rather than the branded claim page.
    if (!clientId || !clientSecret) return res.status(500).send('OAuth not configured');
    if (!process.env.TOKEN_ENCRYPTION_KEY) return res.status(500).send('Token encryption not configured');

    // Everything past this point is reachable by a real person mid-flow, so
    // failures redirect back to the claim page's own error state rather than
    // showing a bare text response.
    const toClaimError = reason => res.redirect(`${publicUrl.replace(/\/$/, '')}/claim.html?error=${reason}`);
    if (!code) return toClaimError('missing_code');
    const redirectUri = `${publicUrl.replace(/\/$/, '')}/claim/google/callback`;
    const oauth2Client = buildOAuth2Client(clientId, clientSecret, redirectUri);
    try {
      const { tokens } = await oauth2Client.getToken(code);
      const refreshToken = tokens.refresh_token || null;
      // Find claim token record
      if (!token) return toClaimError('missing_token');
      const record = repo.findClaimToken(token);
      if (!record) return toClaimError('not_found');
      if (new Date(record.expires_at) < new Date()) return toClaimError('expired');

      const encryptedRefreshToken = refreshToken ? encryptToken(refreshToken) : null;

      const existing = repo.findByPhoneHash(record.phone_number_hash);
      if (existing) {
        repo.updateAccount(existing.id, {
          storage_provider: 'google_drive',
          provider_folder_id: null,
          encrypted_refresh_token: encryptedRefreshToken,
          claimed_at: new Date().toISOString(),
          status: 'active'
        });
      } else {
        repo.createAccount({
          phone_number_hash: record.phone_number_hash,
          storage_provider: 'google_drive',
          provider_folder_id: null,
          encrypted_refresh_token: encryptedRefreshToken,
          claimed_at: new Date().toISOString(),
          last_active_at: null,
          status: 'active'
        });
      }
      repo.deleteClaimToken(token);
      res.redirect(`${publicUrl.replace(/\/$/, '')}/claim.html?done=1`);
    } catch (err) {
      console.error('OAuth callback error', err);
      toClaimError('exchange_failed');
    }
  });

  return router;
}

module.exports = createClaimRouter;
