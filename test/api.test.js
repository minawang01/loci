const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const createApiRouter = require('../routes/api');
const { requireAuth, issueSession, COOKIE_NAME } = require('../lib/auth');
const { resolveDashboardStores } = require('../lib/accounts/resolveDashboardStores');
const { buildStores } = require('../lib/stores');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');
const { hashPhone } = require('../lib/phone');
const { encryptToken } = require('../lib/tokenCrypto');

// In-memory stand-in for a storage provider: one map per bundle, so the owner's
// notes and each account's notes are as isolated as separate Drive folders are.
function memoryProvider() {
  const files = new Map();
  return {
    async readFile(path) {
      return files.has(path) ? files.get(path) : null;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async listFiles() {
      return Array.from(files.keys());
    },
    async deleteFile(path) {
      files.delete(path);
    },
    async ensureDataDir() {}
  };
}

describe('dashboard API per session identity', function() {
  const password = 'test-dashboard-password';
  const originals = {};
  let server;
  let port;
  let repo;
  let ownerStores;
  const accountProviders = new Map();
  // Real plan generation would call Anthropic, which no test should do.
  const planStub = { generatePlan: async () => ({ suggestions: [], message: 'plan' }) };

  before(function() {
    for (const key of ['DASHBOARD_PASSWORD', 'ACCOUNT_HASH_SECRET', 'TOKEN_ENCRYPTION_KEY']) {
      originals[key] = process.env[key];
    }
    process.env.DASHBOARD_PASSWORD = password;
    process.env.ACCOUNT_HASH_SECRET = 'test-secret';
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  });

  after(function() {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async function() {
    repo = new UserAccountRepository(':memory:');
    ownerStores = buildStores(memoryProvider());
    accountProviders.clear();

    const app = express();
    app.use(bodyParser.json());
    app.use(
      '/api',
      requireAuth,
      resolveDashboardStores({
        accountRepo: repo,
        ownerStores,
        ownerPlan: planStub,
        // Never touch Google: each account id gets its own in-memory provider,
        // stable across requests so writes are visible to later reads.
        createProvider: account => {
          if (!accountProviders.has(account.id)) accountProviders.set(account.id, memoryProvider());
          return accountProviders.get(account.id);
        },
        createPlan: () => planStub
      }),
      createApiRouter({ sms: { canSend: () => false, sendMessage: async () => {} } })
    );

    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterEach(function() {
    if (server) server.close();
  });

  function request(method, path, { cookie, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      if (cookie) headers.Cookie = `${COOKIE_NAME}=${cookie}`;
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
        let raw = '';
        res.on('data', chunk => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              body: raw ? JSON.parse(raw) : null,
              setCookie: res.headers['set-cookie']
            });
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  function claimedAccount(phone) {
    return repo.createAccount({
      phone_number_hash: hashPhone(phone),
      storage_provider: 'google_drive',
      encrypted_refresh_token: encryptToken('fake-refresh-token'),
      status: 'active'
    });
  }

  const ownerCookie = () => issueSession(password, { role: 'owner' });
  const accountCookie = id => issueSession(password, { role: 'account', accountId: id });

  it('reports which identity a session carries', async function() {
    const account = claimedAccount('+15551230000');
    assert.deepStrictEqual((await request('GET', '/api/whoami', { cookie: ownerCookie() })).body, {
      role: 'owner'
    });
    assert.deepStrictEqual(
      (await request('GET', '/api/whoami', { cookie: accountCookie(account.id) })).body,
      { role: 'account', accountId: account.id }
    );
  });

  it('rejects a request with no session', async function() {
    const res = await request('GET', '/api/notes');
    assert.strictEqual(res.status, 401);
  });

  it('keeps owner notes and account notes apart', async function() {
    const account = claimedAccount('+15551230000');

    const owner = ownerCookie();
    const theirs = accountCookie(account.id);
    assert.strictEqual((await request('POST', '/api/notes', { cookie: owner, body: { text: 'owner note' } })).status, 201);
    assert.strictEqual((await request('POST', '/api/notes', { cookie: theirs, body: { text: 'their note' } })).status, 201);

    const ownerFeed = await request('GET', '/api/notes', { cookie: owner });
    const accountFeed = await request('GET', '/api/notes', { cookie: theirs });
    assert.deepStrictEqual(ownerFeed.body.map(entry => entry.body), ['owner note']);
    assert.deepStrictEqual(accountFeed.body.map(entry => entry.body), ['their note']);
  });

  it('cuts a session off as soon as its account stops being active', async function() {
    const account = claimedAccount('+15551230000');
    const cookie = accountCookie(account.id);
    assert.strictEqual((await request('GET', '/api/notes', { cookie })).status, 200);

    repo.updateAccount(account.id, { status: 'revoked' });

    const res = await request('GET', '/api/notes', { cookie });
    assert.strictEqual(res.status, 401);
    assert.ok(String(res.setCookie).includes(`${COOKIE_NAME}=;`));
  });

  it('401s a session naming an account that does not exist', async function() {
    const res = await request('GET', '/api/notes', { cookie: accountCookie(4242) });
    assert.strictEqual(res.status, 401);
  });

  it('never texts a plan on an account session', async function() {
    const account = claimedAccount('+15551230000');
    const sent = [];
    const app = express();
    app.use(bodyParser.json());
    app.use(
      '/api',
      requireAuth,
      resolveDashboardStores({
        accountRepo: repo,
        ownerStores,
        ownerPlan: planStub,
        createProvider: () => memoryProvider(),
        createPlan: () => planStub
      }),
      createApiRouter({
        sms: { canSend: () => true, sendMessage: async (to, message) => sent.push({ to, message }) }
      })
    );
    server.close();
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;

    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalPhone = process.env.PLAN_PHONE_NUMBER;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.PLAN_PHONE_NUMBER = '+15550001111';
    try {
      const res = await request('POST', '/api/plan', {
        cookie: accountCookie(account.id),
        body: { send: true }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.sent, false);
      assert.deepStrictEqual(sent, []);
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
      if (originalPhone === undefined) delete process.env.PLAN_PHONE_NUMBER;
      else process.env.PLAN_PHONE_NUMBER = originalPhone;
    }
  });
});
