const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { normalizePhone, hashPhone } = require('../lib/phone');
const { encryptToken } = require('../lib/tokenCrypto');

// Factory to allow injecting a repo for tests
function createClaimRouter(userRepo) {
  const repo = userRepo;
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
    const url = `${(process.env.PUBLIC_URL || '')}/claim?token=${token}`;
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
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
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
    if (!clientId || !clientSecret) return res.status(500).send('OAuth not configured');
    if (!process.env.TOKEN_ENCRYPTION_KEY) return res.status(500).send('Token encryption not configured');
    if (!code) return res.status(400).send('Missing code');
    const redirectUri = `${publicUrl.replace(/\/$/, '')}/claim/google/callback`;
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    try {
      const { tokens } = await oauth2Client.getToken(code);
      const refreshToken = tokens.refresh_token || null;
      // Find claim token record
      if (!token) return res.status(400).send('Missing state token');
      const record = repo.findClaimToken(token);
      if (!record) return res.status(404).send('Claim token not found');
      if (new Date(record.expires_at) < new Date()) return res.status(410).send('token expired');

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
      // Redirect to a simple success page or claim UI
      res.redirect((process.env.PUBLIC_URL || '') + '/claim.html?done=1');
    } catch (err) {
      console.error('OAuth callback error', err);
      res.status(502).send('OAuth exchange failed');
    }
  });

  return router;
}

module.exports = createClaimRouter;
