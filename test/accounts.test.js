const assert = require('assert');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');

describe('UserAccountRepository', function() {
  const repo = new UserAccountRepository(':memory:');

  it('creates and finds an account', function() {
    const acc = repo.createAccount({ phone_number_hash: 'hash1' });
    assert.ok(acc.id);
    const found = repo.findByPhoneHash('hash1');
    assert.strictEqual(found.phone_number_hash, 'hash1');
  });

  it('updates an account', function() {
    const acc = repo.createAccount({ phone_number_hash: 'hash2' });
    const updated = repo.updateAccount(acc.id, { status: 'active' });
    assert.strictEqual(updated.status, 'active');
  });

  it('creates and finds a claim token', function() {
    const token = repo.createClaimToken('t1', 'hash3', new Date().toISOString());
    const found = repo.findClaimToken('t1');
    assert.strictEqual(found.token, 't1');
  });
});
