const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const createLoginRouter = require('../routes/login');
const createOnboardingRouter = require('../routes/onboarding');
const createInvitesRouter = require('../routes/invites');
const createApiRouter = require('../routes/api');
const { requireAuth, issueSession, parseSession, COOKIE_NAME } = require('../lib/auth');
const { resolveDashboardStores } = require('../lib/accounts/resolveDashboardStores');
const { onboardingGate } = require('../lib/accounts/onboardingGate');
const { createVerifiedPhoneStore } = require('../lib/accounts/verifiedPhones');
const { createAttemptLimiter } = require('../lib/attemptLimit');
const { mintInvite } = require('../lib/accounts/invites');
const { buildStores } = require('../lib/stores');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');
const { hashPhone } = require('../lib/phone');
const { decryptToken } = require('../lib/tokenCrypto');

const PASSWORD = 'test-dashboard-password';
const OWNER_PHONE = '+15550000001';
const NEW_PHONE = '+15551112222';
const OTHER_PHONE = '+15553334444';
const CODE = '123456';

function memoryProvider() {
  const files = new Map();
  return {
    async readFile(p) { return files.has(p) ? files.get(p) : null; },
    async writeFile(p, content) { files.set(p, content); },
    async listFiles() { return Array.from(files.keys()); },
    async deleteFile(p) { files.delete(p); },
    async ensureDataDir() {}
  };
}

describe('invite-gated sign-up and onboarding', function() {
  const originals = {};
  let server;
  let port;
  let repo;
  let verifiedPhones;
  let sentCodes;
  let sentMessages;
  let smsFails;
  let oauthTokens;
  let phoneLimiter;

  // Stands in for Twilio Verify: records what a real deployment would pay for.
  const otpStub = {
    otpEnabled: () => true,
    normalizePhone: require('../lib/phone').normalizePhone,
    allowedPhones: () => [],
    sendCode: async phone => { sentCodes.push(phone); },
    checkCode: async (phone, code) => code === CODE
  };

  before(function() {
    for (const key of [
      'DASHBOARD_PASSWORD', 'ACCOUNT_HASH_SECRET', 'TOKEN_ENCRYPTION_KEY', 'OWNER_PHONE_NUMBER',
      'PUBLIC_URL', 'TWILIO_SMS_NUMBER', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'LOGIN_PHONE_NUMBERS'
    ]) {
      originals[key] = process.env[key];
    }
    process.env.DASHBOARD_PASSWORD = PASSWORD;
    process.env.ACCOUNT_HASH_SECRET = 'test-secret';
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.OWNER_PHONE_NUMBER = OWNER_PHONE;
    process.env.PUBLIC_URL = 'https://loci.test';
    process.env.TWILIO_SMS_NUMBER = '+15557654321';
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    delete process.env.LOGIN_PHONE_NUMBERS;
  });

  after(function() {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async function() {
    repo = new UserAccountRepository(':memory:');
    verifiedPhones = createVerifiedPhoneStore();
    sentCodes = [];
    sentMessages = [];
    smsFails = false;
    oauthTokens = { refresh_token: 'google-refresh-token' };
    phoneLimiter = createAttemptLimiter({ limit: 3, windowMs: 15 * 60 * 1000 });

    const smsStub = {
      canSend: () => true,
      sendMessage: async (to, body) => {
        if (smsFails) throw new Error('21610 unsubscribed recipient');
        sentMessages.push({ to, body });
        return 'SM123';
      }
    };
    // Never talks to Google: the code exchange is whatever the test set up.
    const oauthStub = {
      generateAuthUrl: options => `https://accounts.google.com/o/oauth2/auth?state=${options.state}`,
      getToken: async () => {
        if (oauthTokens instanceof Error) throw oauthTokens;
        return { tokens: oauthTokens };
      }
    };
    const passThrough = (req, res, next) => next();
    const planStub = { generatePlan: async () => ({ suggestions: [], message: 'plan' }) };
    const accountProviders = new Map();

    const app = express();
    app.use(bodyParser.json());
    app.use('/login', createLoginRouter({
      accountRepo: repo,
      otp: otpStub,
      verifiedPhones,
      ipLimiters: { start: passThrough, check: passThrough },
      phoneLimiter
    }));
    app.use('/onboarding', requireAuth, createOnboardingRouter({
      accountRepo: repo,
      verifiedPhones,
      sms: smsStub,
      createOAuth2Client: () => oauthStub
    }));
    app.use('/invites', requireAuth, createInvitesRouter({ accountRepo: repo }));
    app.use('/api', requireAuth, resolveDashboardStores({
      accountRepo: repo,
      ownerStores: buildStores(memoryProvider()),
      ownerPlan: planStub,
      createProvider: account => {
        if (!accountProviders.has(account.id)) accountProviders.set(account.id, memoryProvider());
        return accountProviders.get(account.id);
      },
      createPlan: () => planStub
    }), createApiRouter({ sms: smsStub }));
    app.use(requireAuth, onboardingGate({ accountRepo: repo }),
      express.static(path.join(__dirname, '..', 'public')));

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterEach(function() {
    if (server) server.close();
  });

  function request(method, target, { cookie, body, accept } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      if (cookie) headers.Cookie = `${COOKIE_NAME}=${cookie}`;
      if (accept) headers.Accept = accept;
      const req = http.request({ hostname: '127.0.0.1', port, path: target, method, headers }, res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (err) { parsed = null; }
          resolve({
            status: res.statusCode,
            body: parsed,
            text: raw,
            location: res.headers.location,
            cookie: sessionFrom(res.headers['set-cookie'])
          });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  function sessionFrom(setCookie) {
    const header = (setCookie || []).find(value => value.startsWith(`${COOKIE_NAME}=`));
    if (!header) return null;
    const value = header.slice(COOKIE_NAME.length + 1).split(';')[0];
    return value || null;
  }

  const ownerCookie = () => issueSession(PASSWORD, { role: 'owner' });
  const invite = () => mintInvite(repo, {}).code;

  // Signs a number up all the way to a verified, not-yet-connected session.
  async function signUp(phone = NEW_PHONE, code = invite()) {
    const start = await request('POST', '/login/otp/start', { body: { phone, invite: code } });
    assert.strictEqual(start.status, 200);
    const check = await request('POST', '/login/otp/check', { body: { phone, code: CODE, invite: code } });
    assert.strictEqual(check.status, 200);
    return { cookie: check.cookie, check, code };
  }

  describe('requesting a code', function() {
    it('sends nothing to an unknown number with no invite, and says so to nobody', async function() {
      const res = await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { ok: true });
      assert.deepStrictEqual(sentCodes, []);
    });

    it('rejects an invite code that does not exist without sending a code', async function() {
      const res = await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE, invite: 'ABCD-2345' } });
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(sentCodes, []);
    });

    it('sends a code against a valid invite and reserves it for that number', async function() {
      const code = invite();
      const res = await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE, invite: code } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(sentCodes, [NEW_PHONE]);

      const reserved = repo.findInvite(code);
      assert.strictEqual(reserved.phone_number_hash, hashPhone(NEW_PHONE));
      assert.strictEqual(reserved.redeemed_at, null);
    });

    it('accepts a lowercase, unpunctuated invite code', async function() {
      const code = invite();
      const res = await request('POST', '/login/otp/start', {
        body: { phone: NEW_PHONE, invite: code.replace('-', '').toLowerCase() }
      });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(sentCodes, [NEW_PHONE]);
    });

    it('refuses an invite already reserved by another number', async function() {
      const code = invite();
      await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE, invite: code } });
      const res = await request('POST', '/login/otp/start', { body: { phone: OTHER_PHONE, invite: code } });
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(sentCodes, [NEW_PHONE]);
    });

    it('refuses a spent invite', async function() {
      const { code } = await signUp();
      const res = await request('POST', '/login/otp/start', { body: { phone: OTHER_PHONE, invite: code } });
      assert.strictEqual(res.status, 400);
    });

    it('needs no invite from the owner number', async function() {
      const res = await request('POST', '/login/otp/start', { body: { phone: OWNER_PHONE } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(sentCodes, [OWNER_PHONE]);
    });

    it('caps codes per number, not just per address', async function() {
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.strictEqual((await request('POST', '/login/otp/start', { body: { phone: OWNER_PHONE } })).status, 200);
      }
      const capped = await request('POST', '/login/otp/start', { body: { phone: OWNER_PHONE } });
      assert.strictEqual(capped.status, 429);
      assert.strictEqual(sentCodes.length, 3);

      // A different number is unaffected by the first one's cap.
      const other = await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE, invite: invite() } });
      assert.strictEqual(other.status, 200);
    });
  });

  describe('verifying a code', function() {
    it('creates a pending account and an onboarding session', async function() {
      const { check, cookie } = await signUp();
      assert.deepStrictEqual(check.body, { ok: true, onboarding: true });

      const account = repo.findByPhoneHash(hashPhone(NEW_PHONE));
      assert.strictEqual(account.status, 'pending');
      assert.strictEqual(account.encrypted_refresh_token, null);
      assert.deepStrictEqual(parseSession(cookie, PASSWORD), { role: 'account', accountId: account.id });
    });

    it('spends the invite only once the code is right', async function() {
      const code = invite();
      await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE, invite: code } });

      const wrong = await request('POST', '/login/otp/check', { body: { phone: NEW_PHONE, code: '000000', invite: code } });
      assert.strictEqual(wrong.status, 401);
      assert.strictEqual(repo.findInvite(code).redeemed_at, null);
      assert.strictEqual(repo.findByPhoneHash(hashPhone(NEW_PHONE)), null);

      await request('POST', '/login/otp/check', { body: { phone: NEW_PHONE, code: CODE, invite: code } });
      assert.ok(repo.findInvite(code).redeemed_at);
    });

    it('gives the owner number the owner view, with no onboarding', async function() {
      const res = await request('POST', '/login/otp/check', { body: { phone: OWNER_PHONE, code: CODE } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { ok: true });
      assert.deepStrictEqual(parseSession(res.cookie, PASSWORD), { role: 'owner' });
    });

    it('will not sign a revoked number back up', async function() {
      const code = invite();
      repo.createAccount({ phone_number_hash: hashPhone(NEW_PHONE), status: 'revoked' });
      const res = await request('POST', '/login/otp/check', { body: { phone: NEW_PHONE, code: CODE, invite: code } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(repo.findByPhoneHash(hashPhone(NEW_PHONE)).status, 'revoked');
    });

    it('lets a half-onboarded number back in without a second invite', async function() {
      await signUp();
      const account = repo.findByPhoneHash(hashPhone(NEW_PHONE));

      // The invite is spent, but the account it made is still waiting on Drive.
      const start = await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE } });
      assert.strictEqual(start.status, 200);
      assert.deepStrictEqual(sentCodes, [NEW_PHONE, NEW_PHONE]);

      const check = await request('POST', '/login/otp/check', { body: { phone: NEW_PHONE, code: CODE } });
      assert.deepStrictEqual(check.body, { ok: true, onboarding: true });
      assert.deepStrictEqual(parseSession(check.cookie, PASSWORD), { role: 'account', accountId: account.id });
    });

    it('rejects a code with no invite and no account behind it', async function() {
      const res = await request('POST', '/login/otp/check', { body: { phone: NEW_PHONE, code: CODE } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.cookie, null);
    });
  });

  describe('before Drive is connected', function() {
    it('holds the dashboard back and sends the browser to onboarding', async function() {
      const { cookie } = await signUp();
      const page = await request('GET', '/', { cookie, accept: 'text/html' });
      assert.strictEqual(page.status, 302);
      assert.strictEqual(page.location, '/onboarding');
    });

    it('answers the notes API with an onboarding error, keeping the session', async function() {
      const { cookie } = await signUp();
      const res = await request('GET', '/api/notes', { cookie });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.onboarding, true);
      assert.strictEqual(res.cookie, null); // not signed out — onboarding is unfinished, not invalid
    });

    it('serves the welcome page with the connect call to action', async function() {
      const { cookie } = await signUp();
      const res = await request('GET', '/onboarding', { cookie, accept: 'text/html' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.text.includes('Welcome to loci'));
      assert.ok(res.text.includes('Connect your Google Drive to start saving notes'));
    });

    it('sends the owner to the dashboard instead of onboarding', async function() {
      const res = await request('GET', '/onboarding', { cookie: ownerCookie(), accept: 'text/html' });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.location, '/');
    });

    it('refuses to mint invites for anyone but the owner', async function() {
      const { cookie } = await signUp();
      assert.strictEqual((await request('POST', '/invites', { cookie, body: {} })).status, 403);

      const minted = await request('POST', '/invites', { cookie: ownerCookie(), body: {} });
      assert.strictEqual(minted.status, 200);
      assert.ok(repo.findInvite(minted.body.code));
      assert.ok(minted.body.url.includes(`invite=${encodeURIComponent(minted.body.code)}`));
    });
  });

  describe('connecting Drive', function() {
    async function connect(cookie, { state } = {}) {
      const start = await request('GET', '/onboarding/google/start', { cookie });
      assert.strictEqual(start.status, 302);
      const authState = state || new URL(start.location).searchParams.get('state');
      return request('GET', `/onboarding/google/callback?code=auth-code&state=${encodeURIComponent(authState)}`, { cookie });
    }

    it('activates the account, stores the refresh token encrypted, and texts a welcome', async function() {
      const { cookie } = await signUp();
      const res = await connect(cookie);

      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.location, 'https://loci.test/onboarding?connected=1&texted=1');

      const account = repo.findByPhoneHash(hashPhone(NEW_PHONE));
      assert.strictEqual(account.status, 'active');
      assert.strictEqual(decryptToken(account.encrypted_refresh_token), 'google-refresh-token');

      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].to, NEW_PHONE);
      assert.ok(sentMessages[0].body.includes('Welcome to loci'));
      assert.ok(sentMessages[0].body.includes('#todo'));
    });

    it('still connects when the welcome text cannot be delivered', async function() {
      const { cookie } = await signUp();
      smsFails = true;
      const res = await connect(cookie);

      assert.strictEqual(res.location, 'https://loci.test/onboarding?connected=1&texted=0');
      assert.strictEqual(repo.findByPhoneHash(hashPhone(NEW_PHONE)).status, 'active');
      assert.deepStrictEqual(sentMessages, []);
    });

    it('opens the dashboard once connected', async function() {
      const { cookie } = await signUp();
      await connect(cookie);

      const notes = await request('GET', '/api/notes', { cookie });
      assert.strictEqual(notes.status, 200);
      const created = await request('POST', '/api/notes', { cookie, body: { text: 'first note' } });
      assert.strictEqual(created.status, 201);
    });

    it('lets the number sign in on its own from then on, with no invite', async function() {
      const { cookie } = await signUp();
      await connect(cookie);

      const start = await request('POST', '/login/otp/start', { body: { phone: NEW_PHONE } });
      assert.strictEqual(start.status, 200);
      const check = await request('POST', '/login/otp/check', { body: { phone: NEW_PHONE, code: CODE } });
      assert.deepStrictEqual(check.body, { ok: true });
      const account = repo.findByPhoneHash(hashPhone(NEW_PHONE));
      assert.deepStrictEqual(parseSession(check.cookie, PASSWORD), { role: 'account', accountId: account.id });
    });

    it('does not walk a connected account back into onboarding', async function() {
      const { cookie } = await signUp();
      await connect(cookie);
      const account = repo.findByPhoneHash(hashPhone(NEW_PHONE));

      // Even handed a fresh invite, a connected number just signs in.
      const res = await request('POST', '/login/otp/check', {
        body: { phone: NEW_PHONE, code: CODE, invite: invite() }
      });
      assert.deepStrictEqual(res.body, { ok: true });
      assert.strictEqual(repo.findById(account.id).status, 'active');
    });

    it('shows the completion page with the number to text', async function() {
      const { cookie } = await signUp();
      await connect(cookie);

      const page = await request('GET', '/onboarding?connected=1&texted=1', { cookie, accept: 'text/html' });
      assert.strictEqual(page.status, 200);
      const status = await request('GET', '/onboarding/status', { cookie });
      assert.deepStrictEqual(status.body, {
        onboarding: false,
        connected: true,
        sms_number: process.env.TWILIO_SMS_NUMBER
      });
    });

    it('refuses a state belonging to another session', async function() {
      const first = await signUp();
      const second = await signUp(OTHER_PHONE);

      const start = await request('GET', '/onboarding/google/start', { cookie: first.cookie });
      const stolen = new URL(start.location).searchParams.get('state');
      const res = await request('GET', `/onboarding/google/callback?code=auth-code&state=${stolen}`, {
        cookie: second.cookie
      });

      assert.strictEqual(res.location, 'https://loci.test/onboarding?error=session_mismatch');
      assert.strictEqual(repo.findByPhoneHash(hashPhone(NEW_PHONE)).status, 'pending');
      assert.strictEqual(repo.findByPhoneHash(hashPhone(OTHER_PHONE)).status, 'pending');
    });

    it('refuses a forged state', async function() {
      const { cookie } = await signUp();
      const account = repo.findByPhoneHash(hashPhone(NEW_PHONE));
      const res = await request(
        'GET',
        `/onboarding/google/callback?code=auth-code&state=${account.id}.${Date.now()}.deadbeef`,
        { cookie }
      );
      assert.strictEqual(res.location, 'https://loci.test/onboarding?error=invalid_state');
      assert.strictEqual(repo.findById(account.id).status, 'pending');
    });

    it('stays pending when Google grants no refresh token', async function() {
      const { cookie } = await signUp();
      oauthTokens = { access_token: 'short-lived' };
      const res = await connect(cookie);

      assert.strictEqual(res.location, 'https://loci.test/onboarding?error=no_refresh_token');
      assert.strictEqual(repo.findByPhoneHash(hashPhone(NEW_PHONE)).status, 'pending');
      assert.deepStrictEqual(sentMessages, []);
    });

    it('stays pending when the token exchange fails', async function() {
      const { cookie } = await signUp();
      oauthTokens = new Error('invalid_grant');
      const res = await connect(cookie);

      assert.strictEqual(res.location, 'https://loci.test/onboarding?error=exchange_failed');
      assert.strictEqual(repo.findByPhoneHash(hashPhone(NEW_PHONE)).status, 'pending');
    });
  });
});
