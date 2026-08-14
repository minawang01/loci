const assert = require('assert');
const { resolveSender } = require('../lib/accounts/resolveSender');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');
const { hashPhone } = require('../lib/phone');
const { encryptToken } = require('../lib/tokenCrypto');

describe('resolveSender', function() {
  const originalHashSecret = process.env.ACCOUNT_HASH_SECRET;
  const originalTokenKey = process.env.TOKEN_ENCRYPTION_KEY;

  before(function() {
    process.env.ACCOUNT_HASH_SECRET = 'test-secret';
    process.env.TOKEN_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
  });

  after(function() {
    if (originalHashSecret === undefined) delete process.env.ACCOUNT_HASH_SECRET;
    else process.env.ACCOUNT_HASH_SECRET = originalHashSecret;
    if (originalTokenKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalTokenKey;
  });

  const ownerPhone = '+14024170066';
  const ownerStores = { marker: 'owner-stores' };

  it('routes the owner number to ownerStores without touching the repo', async function() {
    const repo = { findByPhoneHash: () => { throw new Error('should not be called'); } };
    const result = await resolveSender({ fromNumber: ownerPhone, accountRepo: repo, ownerStores, ownerPhone });
    assert.strictEqual(result.kind, 'owner');
    assert.strictEqual(result.stores, ownerStores);
  });

  it('returns invalid for an unparseable number', async function() {
    const repo = new UserAccountRepository(':memory:');
    const result = await resolveSender({ fromNumber: 'not-a-number', accountRepo: repo, ownerStores, ownerPhone });
    assert.strictEqual(result.kind, 'invalid');
  });

  it('gives an unknown number a claim link, and reuses it on a second text', async function() {
    const repo = new UserAccountRepository(':memory:');
    const from = '+15551234567';

    const first = await resolveSender({ fromNumber: from, accountRepo: repo, ownerStores, ownerPhone, publicUrl: 'https://loci.example.com' });
    assert.strictEqual(first.kind, 'unclaimed');
    assert.ok(first.claimUrl.startsWith('https://loci.example.com/claim.html?token='));

    const second = await resolveSender({ fromNumber: from, accountRepo: repo, ownerStores, ownerPhone, publicUrl: 'https://loci.example.com' });
    assert.strictEqual(second.claimUrl, first.claimUrl);
  });

  it('routes a claimed account to Drive-backed stores and persists the folder id', async function() {
    const repo = new UserAccountRepository(':memory:');
    const from = '+15559998888';
    const hash = hashPhone(from);
    repo.createAccount({
      phone_number_hash: hash,
      storage_provider: 'google_drive',
      encrypted_refresh_token: encryptToken('fake-refresh-token'),
      status: 'active'
    });

    // Swap in a fake Drive client via GoogleDriveProvider's constructor so no
    // network call happens — resolveSender itself decides *whether* to build
    // one; how it behaves once built is GoogleDriveProvider's own test.
    const GoogleDriveProvider = require('../lib/storage/GoogleDriveProvider');
    const originalEnsureDataDir = GoogleDriveProvider.prototype.ensureDataDir;
    GoogleDriveProvider.prototype.ensureDataDir = async function() {
      return 'fake-folder-id';
    };

    try {
      const result = await resolveSender({ fromNumber: from, accountRepo: repo, ownerStores, ownerPhone });
      assert.strictEqual(result.kind, 'active');
      assert.ok(result.stores.notes);
      assert.ok(result.stores.goals);

      const updated = repo.findByPhoneHash(hash);
      assert.strictEqual(updated.provider_folder_id, 'fake-folder-id');
      assert.ok(updated.last_active_at);
    } finally {
      GoogleDriveProvider.prototype.ensureDataDir = originalEnsureDataDir;
    }
  });

  it('treats an account with no refresh token as unclaimed', async function() {
    const repo = new UserAccountRepository(':memory:');
    const from = '+15557778888';
    repo.createAccount({ phone_number_hash: hashPhone(from), status: 'active' });

    const result = await resolveSender({ fromNumber: from, accountRepo: repo, ownerStores, ownerPhone });
    assert.strictEqual(result.kind, 'unclaimed');
  });
});
