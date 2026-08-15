const express = require('express');
const { mintInvite, INVITE_TTL_MS } = require('../lib/accounts/invites');
const { signupConfigured } = require('../lib/accounts/signup');

// Minting invites is how the owner decides who may sign up, so it is owner-only
// even though the rest of the dashboard is per-account. Mounted behind the auth
// gate; an account session gets 403 rather than a code it could hand out.
function createInvitesRouter({ accountRepo }) {
  const router = express.Router();

  router.use((req, res, next) => {
    const identity = req.lociIdentity;
    if (!identity || identity.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can create invites' });
    }
    next();
  });

  router.post('/', (req, res) => {
    if (!signupConfigured()) {
      return res.status(503).json({ error: 'sign-up is not configured' });
    }
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 200) : null;
    const invite = mintInvite(accountRepo, { note });
    const origin = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    res.json({
      ok: true,
      code: invite.code,
      expires_at: invite.expires_at,
      ttl_days: Math.round(INVITE_TTL_MS / (24 * 60 * 60 * 1000)),
      url: `${origin}/login?invite=${encodeURIComponent(invite.code)}`
    });
  });

  return router;
}

module.exports = createInvitesRouter;
