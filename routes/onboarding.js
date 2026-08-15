const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { google } = require('googleapis');
const { encryptToken } = require('../lib/tokenCrypto');
const { isConnected } = require('../lib/accounts/accountState');
const { sendWelcome } = require('../lib/welcome');

const ONBOARDING_PAGE = path.join(__dirname, '..', 'public', 'onboarding.html');
const STATE_TTL_MS = 30 * 60 * 1000;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// The OAuth `state` names the account being connected, signed so Google's
// round trip can't be used to point someone else's authorisation at another
// account. It carries no phone number: that would put one in Google's logs.
function signState(accountId, issuedAt, secret) {
  return crypto.createHmac('sha256', secret).update(`${accountId}.${issuedAt}`).digest('hex');
}

function encodeState(accountId, secret, issuedAt = Date.now()) {
  return `${accountId}.${issuedAt}.${signState(accountId, issuedAt, secret)}`;
}

function decodeState(state, secret) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const [accountId, issuedAt, signature] = parts;
  if (!/^\d+$/.test(accountId) || !/^\d+$/.test(issuedAt)) return null;
  if (Date.now() - Number(issuedAt) > STATE_TTL_MS) return null;
  const expected = signState(accountId, issuedAt, secret);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return Number(accountId);
}

// Onboarding for a number that has verified itself but has nowhere to keep its
// notes yet: it describes the app, connects Google Drive, and then hands over
// the texting instructions. Mounted behind the auth gate — every route here
// belongs to the session it is completing.
//
// `createOAuth2Client` and `sms` are injection points for tests; real usage
// omits them and gets googleapis and lib/sms.
function createOnboardingRouter({
  accountRepo,
  verifiedPhones,
  sms = require('../lib/sms'),
  createOAuth2Client
}) {
  const buildOAuth2Client =
    createOAuth2Client ||
    ((clientId, clientSecret, redirectUri) =>
      new google.auth.OAuth2(clientId, clientSecret, redirectUri));
  const router = express.Router();

  function stateSecret() {
    return process.env.DASHBOARD_PASSWORD || '';
  }

  function publicOrigin() {
    return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  }

  function redirectUri() {
    return `${publicOrigin()}/onboarding/google/callback`;
  }

  // The account behind this session, or null for the owner's session — the
  // owner has no account row and nothing to onboard.
  function accountFor(req) {
    const identity = req.lociIdentity;
    if (!identity || identity.role !== 'account') return null;
    return accountRepo.findById(identity.accountId) || null;
  }

  // The account still waiting on a Drive, or null.
  function onboardingAccount(req) {
    const account = accountFor(req);
    return account && !isConnected(account) ? account : null;
  }

  router.get('/', (req, res) => {
    // An account that has just connected still gets this page: it is where the
    // "you're set up, here's the number" instructions live.
    const justConnected = req.query.connected === '1' && Boolean(accountFor(req));
    if (!onboardingAccount(req) && !justConnected) return res.redirect('/');
    res.sendFile(ONBOARDING_PAGE);
  });

  // Feeds the page the number to text, which the page can't read from the
  // dashboard API — a pending session has no API access.
  router.get('/status', (req, res) => {
    const account = accountFor(req);
    res.json({
      onboarding: Boolean(account) && !isConnected(account),
      connected: isConnected(account),
      sms_number: process.env.TWILIO_SMS_NUMBER || null
    });
  });

  router.get('/google/start', (req, res) => {
    const account = onboardingAccount(req);
    if (!account) return res.redirect('/');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.status(500).send('OAuth not configured');
    if (!process.env.TOKEN_ENCRYPTION_KEY) return res.status(500).send('Token encryption not configured');

    const oauth2Client = buildOAuth2Client(clientId, clientSecret, redirectUri());
    res.redirect(
      oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [DRIVE_SCOPE],
        state: encodeState(account.id, stateSecret())
      })
    );
  });

  router.get('/google/callback', async (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.status(500).send('OAuth not configured');
    if (!process.env.TOKEN_ENCRYPTION_KEY) return res.status(500).send('Token encryption not configured');

    // Everything past here is reachable by a real person mid-flow, so failures
    // go back to the onboarding page's own error state.
    const toError = reason => res.redirect(`${publicOrigin()}/onboarding?error=${reason}`);
    const accountId = decodeState(req.query.state, stateSecret());
    if (!req.query.code) return toError('missing_code');
    if (!accountId) return toError('invalid_state');

    // The signed state and the session have to agree: a state is only good for
    // the session that asked for it.
    const identity = req.lociIdentity;
    if (!identity || identity.role !== 'account' || identity.accountId !== accountId) {
      return toError('session_mismatch');
    }
    const account = accountRepo.findById(accountId);
    if (!account || account.status === 'revoked') return toError('not_found');

    let refreshToken = null;
    try {
      const { tokens } = await buildOAuth2Client(clientId, clientSecret, redirectUri()).getToken(
        req.query.code
      );
      refreshToken = tokens.refresh_token || null;
    } catch (err) {
      console.error('OAuth callback error', err);
      return toError('exchange_failed');
    }
    // Without a refresh token there is no way back into the Drive later, so the
    // account would look connected and then fail on its first note.
    if (!refreshToken) return toError('no_refresh_token');

    accountRepo.updateAccount(account.id, {
      storage_provider: 'google_drive',
      encrypted_refresh_token: encryptToken(refreshToken),
      claimed_at: new Date().toISOString(),
      status: 'active'
    });

    // Best effort: the same instructions are on the page, so a text that can't
    // be delivered doesn't cost the new account anything.
    const texted = await sendWelcome(sms, verifiedPhones && verifiedPhones.take(account.id));
    res.redirect(`${publicOrigin()}/onboarding?connected=1&texted=${texted ? 1 : 0}`);
  });

  return router;
}

module.exports = createOnboardingRouter;
module.exports.encodeState = encodeState;
module.exports.decodeState = decodeState;
