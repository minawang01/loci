const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const createClaimRouter = require('../routes/claim');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');

describe('Claim flow routes', function() {
  const originalHashSecret = process.env.ACCOUNT_HASH_SECRET;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;
  const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

  before(function() {
    process.env.ACCOUNT_HASH_SECRET = 'test-secret';
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  after(function() {
    if (originalHashSecret === undefined) delete process.env.ACCOUNT_HASH_SECRET;
    else process.env.ACCOUNT_HASH_SECRET = originalHashSecret;
    if (originalClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalClientSecret;
    if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
  });

  it('creates and completes a claim', async function() {
    const app = express();
    app.use(bodyParser.json());
    const repo = new UserAccountRepository(':memory:');
    app.use('/claim', createClaimRouter(repo));

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    function post(path, body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const opts = { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
        const req = http.request(opts, res => {
          let raw = '';
          res.on('data', c => (raw += c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }); }
            catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    }

    const r1 = await post('/claim/request', { phone: '+14025551234' });
    assert.strictEqual(r1.status, 200);
    assert.ok(r1.body.token);
    const token = r1.body.token;

    const r2 = await post('/claim/complete', { token, provider_folder_id: 'pf1' });
    assert.strictEqual(r2.status, 200);

    const { hashPhone } = require('../lib/phone');
    const acct = repo.findByPhoneHash(hashPhone('+14025551234'));
    assert.ok(acct);
    assert.strictEqual(acct.provider_folder_id, 'pf1');

    server.close();
  });

  describe('OAuth callback error redirects', function() {
    let server, port, repo;

    // Stub OAuth2 client: never touches the network. getToken always
    // resolves so the callback can reach its post-exchange branches; tests
    // that need the exchange itself to fail override getToken per-case.
    function startServer(oauth2Overrides) {
      repo = new UserAccountRepository(':memory:');
      const stubClient = Object.assign({
        generateAuthUrl: () => 'https://accounts.google.com/o/oauth2/stub',
        getToken: async () => ({ tokens: { refresh_token: 'stub-refresh-token' } })
      }, oauth2Overrides);
      const app = express();
      app.use(bodyParser.json());
      app.use('/claim', createClaimRouter(repo, () => stubClient));

      server = http.createServer(app);
      return new Promise(resolve => server.listen(0, () => {
        port = server.address().port;
        resolve();
      }));
    }

    afterEach(function() {
      if (server) server.close();
    });

    function getNoRedirect(path) {
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
        });
        req.on('error', reject);
        req.end();
      });
    }

    it('redirects with error=missing_code when Google omits the code param', async function() {
      await startServer();
      const r = await getNoRedirect('/claim/google/callback?state=sometoken');
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.location, '/claim.html?error=missing_code');
    });

    it('redirects with error=missing_token when state is absent', async function() {
      await startServer();
      const r = await getNoRedirect('/claim/google/callback?code=authcode');
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.location, '/claim.html?error=missing_token');
    });

    it('redirects with error=not_found for an unknown claim token', async function() {
      await startServer();
      const r = await getNoRedirect('/claim/google/callback?code=authcode&state=nonexistent-token');
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.location, '/claim.html?error=not_found');
    });

    it('redirects with error=expired for a claim token past its expiry', async function() {
      await startServer();
      const token = 'expired-token';
      repo.createClaimToken(token, 'some-phone-hash', new Date(Date.now() - 1000).toISOString());
      const r = await getNoRedirect(`/claim/google/callback?code=authcode&state=${token}`);
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.location, '/claim.html?error=expired');
    });

    it('redirects with error=exchange_failed when the token exchange throws', async function() {
      await startServer({ getToken: async () => { throw new Error('invalid_grant'); } });
      const r = await getNoRedirect('/claim/google/callback?code=badcode&state=sometoken');
      assert.strictEqual(r.status, 302);
      assert.strictEqual(r.location, '/claim.html?error=exchange_failed');
    });
  });
});
