const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { credentialsMatch, isAuthenticated, setSessionCookie } = require('../lib/auth');
const { createAttemptLimiter } = require('../lib/attemptLimit');
const { hashPhone } = require('../lib/phone');
const { resolveLoginIdentity } = require('../lib/accounts/resolveLogin');
const invites = require('../lib/accounts/invites');
const { isOnboarding } = require('../lib/accounts/accountState');
const { ensurePendingAccount, signupBlocked, signupConfigured } = require('../lib/accounts/signup');

const LOGIN_PAGE = path.join(__dirname, '..', 'public', 'login.html');

// Each code costs money to send and is a chance to guess, so both halves of the
// flow are capped well below anything a real person needs.
function defaultIpLimiters() {
  const common = { windowMs: 15 * 60 * 1000, standardHeaders: 'draft-7', legacyHeaders: false };
  return {
    start: rateLimit({
      ...common,
      limit: 5,
      message: { error: 'Too many codes requested. Try again in a few minutes.' }
    }),
    check: rateLimit({
      ...common,
      limit: 10,
      message: { error: 'Too many attempts. Try again in a few minutes.' }
    })
  };
}

// Sign-in and sign-up over the same two steps: a number proves itself with a
// verification code, and what it may do afterwards is decided here, server-side.
// - the owner number and LOGIN_PHONE_NUMBERS entries get the owner dashboard
// - a number with a connected account gets its own dashboard
// - any other number gets a code only against a valid invite, and lands on
//   onboarding with a pending account until it connects Drive
function createLoginRouter({
  accountRepo,
  otp,
  verifiedPhones,
  ipLimiters = defaultIpLimiters(),
  // Per-number caps, on top of the per-IP ones: without them a single number can
  // be pestered with codes, and its code guessed, from a rotation of addresses.
  phoneLimiter = createAttemptLimiter({ limit: 3, windowMs: 15 * 60 * 1000 }),
  codeLimiter = createAttemptLimiter({ limit: 5, windowMs: 15 * 60 * 1000 }),
  inviteLimiter = createAttemptLimiter({ limit: 5, windowMs: 15 * 60 * 1000 })
}) {
  const router = express.Router();

  function loginIdentityFor(phone) {
    return resolveLoginIdentity({
      phone,
      accountRepo,
      ownerPhone: process.env.OWNER_PHONE_NUMBER,
      loginPhoneNumbers: otp.allowedPhones()
    });
  }

  // The invite a number may sign up with, when it has no dashboard access
  // already. `null` means it may not sign up, which the callers report
  // differently: an invite the person typed gets a real error, an absent one
  // gets the same silence an unrecognised number has always got.
  function signupInviteFor(phone, rawCode) {
    if (!signupConfigured()) return null;
    const code = invites.normalizeCode(rawCode);
    if (!code) return null;
    if (signupBlocked(accountRepo.findByPhoneHash(hashPhone(phone)))) return null;
    return invites.usableInvite(accountRepo, code, hashPhone(phone));
  }

  // A number that verified itself but closed the tab before connecting Drive
  // can come back on its own: its invite is already spent, so asking for one
  // again would lock it out of the account it just made.
  function canResumeOnboarding(phone) {
    if (!signupConfigured()) return false;
    return isOnboarding(accountRepo.findByPhoneHash(hashPhone(phone)));
  }

  router.get('/', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/');
    res.sendFile(LOGIN_PAGE);
  });

  router.post('/', (req, res) => {
    const { username = '', password = '' } = req.body;
    if (!credentialsMatch(username, password)) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }
    setSessionCookie(res, password);
    res.json({ ok: true });
  });

  // Lets the login page hide the phone tab on deployments without Verify
  // configured. Deliberately says nothing about which numbers are allowed.
  router.get('/options', (req, res) => res.json({ otp: otp.otpEnabled(), invites: signupConfigured() }));

  router.post('/otp/start', ipLimiters.start, async (req, res) => {
    if (!otp.otpEnabled()) return res.status(404).json({ error: 'Phone sign-in is not configured' });

    const phone = otp.normalizePhone(req.body.phone);
    // Always answer as if the code was sent: telling a stranger whether a number
    // can sign in would hand them half the credential.
    if (!phone) return res.json({ ok: true });

    const identity = loginIdentityFor(phone);
    const resuming = !identity && canResumeOnboarding(phone);
    const typedCode = identity || resuming ? null : invites.normalizeCode(req.body.invite);

    // A rejected invite must cost the number an attempt: counting only the codes
    // actually sent would leave guessing bounded by the per-IP limiter alone.
    if (typedCode && !inviteLimiter.allow(phone)) {
      return res.status(429).json({ error: 'Too many invite codes tried for that number.' });
    }

    const invite = typedCode ? signupInviteFor(phone, typedCode) : null;
    if (!identity && !resuming && !invite) {
      // An invite code is something the person was given and typed, so a wrong
      // one is worth saying out loud — it reveals nothing about any number.
      if (typedCode) {
        return res.status(400).json({ error: 'That invite code is not valid.' });
      }
      return res.json({ ok: true });
    }

    if (!phoneLimiter.allow(phone)) {
      return res.status(429).json({ error: 'Too many codes requested for that number.' });
    }

    try {
      await otp.sendCode(phone);
    } catch (err) {
      console.error('Failed to send verification code:', err.message);
      return res.status(502).json({ error: 'Could not send a code. Try again shortly.' });
    }
    // Reserved rather than spent: the code still has to be entered, and one that
    // never arrives shouldn't burn the invite.
    if (invite) invites.reserveInvite(accountRepo, invite.code, hashPhone(phone));
    res.json({ ok: true });
  });

  router.post('/otp/check', ipLimiters.check, async (req, res) => {
    if (!otp.otpEnabled()) return res.status(404).json({ error: 'Phone sign-in is not configured' });

    const phone = otp.normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();
    const rejected = { error: 'That code is not valid' };
    if (!phone || !/^\d{4,10}$/.test(code)) return res.status(401).json(rejected);

    // The request side is capped per number, so the guessing side has to be too.
    if (!codeLimiter.allow(phone)) {
      return res.status(429).json({ error: 'Too many attempts for that number. Try again in a few minutes.' });
    }

    // Recomputed server-side from the number that just proved itself — nothing
    // about which account this session gets comes from the client.
    const identity = loginIdentityFor(phone);
    const resuming = !identity && canResumeOnboarding(phone);
    const invite = identity || resuming ? null : signupInviteFor(phone, req.body.invite);
    if (!identity && !resuming && !invite) return res.status(401).json(rejected);

    let approved = false;
    try {
      approved = await otp.checkCode(phone, code);
    } catch (err) {
      console.error('Failed to check verification code:', err.message);
      return res.status(502).json({ error: 'Could not check that code. Try again shortly.' });
    }
    if (!approved) return res.status(401).json(rejected);

    const password = process.env.DASHBOARD_PASSWORD || '';
    if (identity) {
      setSessionCookie(res, password, identity);
      return res.json({ ok: true });
    }

    const account = ensurePendingAccount(accountRepo, phone);
    if (!account) return res.status(403).json({ error: 'That number cannot sign up.' });
    if (invite) invites.redeemInvite(accountRepo, invite.code, hashPhone(phone));
    // Held in memory only, so the welcome text can be sent once Drive is
    // connected — accounts themselves store just a hash of the number.
    if (verifiedPhones) verifiedPhones.remember(account.id, phone);
    setSessionCookie(res, password, { role: 'account', accountId: account.id });
    res.json({ ok: true, onboarding: true });
  });

  return router;
}

module.exports = createLoginRouter;
