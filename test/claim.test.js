const assert = require('assert');
const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const createClaimRouter = require('../routes/claim');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');

describe('Claim flow routes', function() {
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

    const phoneHash = 'ph_test_123';
    const r1 = await post('/claim/request', { phone_number_hash: phoneHash });
    assert.strictEqual(r1.status, 200);
    assert.ok(r1.body.token);
    const token = r1.body.token;

    const r2 = await post('/claim/complete', { token, provider_folder_id: 'pf1' });
    assert.strictEqual(r2.status, 200);

    const acct = repo.findByPhoneHash(phoneHash);
    assert.ok(acct);
    assert.strictEqual(acct.provider_folder_id, 'pf1');

    server.close();
  });
});
