const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');

// Factory to allow injecting a repo for tests
function createClaimRouter(userRepo) {
  const repo = userRepo;
  const router = express.Router();

  // Request a claim token for a phone_number_hash
  router.post('/request', (req, res) => {
    const { phone_number_hash } = req.body;
    if (!phone_number_hash) return res.status(400).json({ error: 'phone_number_hash required' });
    const token = crypto.randomBytes(18).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
    repo.createClaimToken(token, phone_number_hash, expiresAt);
    const url = `${(process.env.PUBLIC_URL || '')}/claim?token=${token}`;
    res.json({ ok: true, token, url, expires_at: expiresAt });
  });

  // Complete claim: attach provider info to account
  router.post('/complete', (req, res) => {
    const { token, storage_provider = 'google_drive', provider_folder_id = null, encrypted_refresh_token = null } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    const record = repo.findClaimToken(token);
    if (!record) return res.status(404).json({ error: 'token not found' });
    if (new Date(record.expires_at) < new Date()) return res.status(410).json({ error: 'token expired' });

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

      const existing = repo.findByPhoneHash(record.phone_number_hash);
      if (existing) {
        repo.updateAccount(existing.id, {
          storage_provider: 'google_drive',
          provider_folder_id: null,
          encrypted_refresh_token: refreshToken,
          claimed_at: new Date().toISOString(),
          status: 'active'
        });
      } else {
        repo.createAccount({
          phone_number_hash: record.phone_number_hash,
          storage_provider: 'google_drive',
          provider_folder_id: null,
          encrypted_refresh_token: refreshToken,
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
