const assert = require('assert');
const { resolveLoginIdentity } = require('../lib/accounts/resolveLogin');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');
const { hashPhone } = require('../lib/phone');
const { encryptToken } = require('../lib/tokenCrypto');

describe('resolveLoginIdentity', function() {
  const originalHashSecret = process.env.ACCOUNT_HASH_SECRET;
  const originalTokenKey = process.env.TOKEN_ENCRYPTION_KEY;
  const ownerPhone = '+14024170066';

  before(function() {
    process.env.ACCOUNT_HASH_SECRET = 'test-secret';
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  });

  after(function() {
    if (originalHashSecret === undefined) delete process.env.ACCOUNT_HASH_SECRET;
    else process.env.ACCOUNT_HASH_SECRET = originalHashSecret;
    if (originalTokenKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalTokenKey;
  });

  function activeAccount(repo, phone) {
    return repo.createAccount({
      phone_number_hash: hashPhone(phone),
      storage_provider: 'google_drive',
      encrypted_refresh_token: encryptToken('fake-refresh-token'),
      status: 'active'
    });
  }

  it('maps the owner number to the owner identity without touching the repo', function() {
    const repo = { findByPhoneHash: () => { throw new Error('should not be called'); } };
    const identity = resolveLoginIdentity({ phone: '402 417 0066', accountRepo: repo, ownerPhone });
    assert.deepStrictEqual(identity, { role: 'owner' });
  });

  it('maps a LOGIN_PHONE_NUMBERS entry to the owner identity', function() {
    const repo = new UserAccountRepository(':memory:');
    const identity = resolveLoginIdentity({
      phone: '+15551110000',
      accountRepo: repo,
      ownerPhone,
      loginPhoneNumbers: ['+15551110000']
    });
    assert.deepStrictEqual(identity, { role: 'owner' });
  });

  it('maps an active claimed account to its own identity', function() {
    const repo = new UserAccountRepository(':memory:');
    const account = activeAccount(repo, '+15559998888');
    const identity = resolveLoginIdentity({ phone: '+15559998888', accountRepo: repo, ownerPhone });
    assert.deepStrictEqual(identity, { role: 'account', accountId: account.id });
  });

  it('refuses an account that is no longer active', function() {
    const repo = new UserAccountRepository(':memory:');
    const account = activeAccount(repo, '+15559998888');
    repo.updateAccount(account.id, { status: 'revoked' });
    assert.strictEqual(resolveLoginIdentity({ phone: '+15559998888', accountRepo: repo, ownerPhone }), null);
  });

  it('refuses an account with no refresh token', function() {
    const repo = new UserAccountRepository(':memory:');
    repo.createAccount({ phone_number_hash: hashPhone('+15557778888'), status: 'active' });
    assert.strictEqual(resolveLoginIdentity({ phone: '+15557778888', accountRepo: repo, ownerPhone }), null);
  });

  it('refuses an unknown number and an unparseable one', function() {
    const repo = new UserAccountRepository(':memory:');
    assert.strictEqual(resolveLoginIdentity({ phone: '+15550000000', accountRepo: repo, ownerPhone }), null);
    assert.strictEqual(resolveLoginIdentity({ phone: 'not-a-number', accountRepo: repo, ownerPhone }), null);
  });
});
