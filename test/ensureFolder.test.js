const assert = require('assert');
const { ensureAccountFolder } = require('../lib/accounts/ensureFolder');
const { resolveDashboardStores } = require('../lib/accounts/resolveDashboardStores');
const UserAccountRepository = require('../lib/accounts/UserAccountRepository');

// Counts folder resolutions the way Drive would charge for them: a list, then a
// create when nothing was found.
function countingProvider(folderId = 'drive-folder') {
  const provider = {
    folderId: null,
    calls: 0,
    async ensureDataDir() {
      provider.calls += 1;
      await new Promise(resolve => setImmediate(resolve));
      provider.folderId = folderId;
      return folderId;
    }
  };
  return provider;
}

describe('ensureAccountFolder', function() {
  let repo;
  let account;

  beforeEach(function() {
    repo = new UserAccountRepository(':memory:');
    account = repo.createAccount({
      phone_number_hash: 'hash-1',
      status: 'active',
      encrypted_refresh_token: 'token'
    });
  });

  it('resolves the folder once for concurrent callers and persists it', async function() {
    const provider = countingProvider();
    const results = await Promise.all([
      ensureAccountFolder(repo, account, provider),
      ensureAccountFolder(repo, account, provider),
      ensureAccountFolder(repo, account, provider)
    ]);

    assert.deepStrictEqual(results, ['drive-folder', 'drive-folder', 'drive-folder']);
    assert.strictEqual(provider.calls, 1);
    assert.strictEqual(repo.findById(account.id).provider_folder_id, 'drive-folder');
  });

  it('asks Drive nothing once the account has a folder', async function() {
    const stored = repo.updateAccount(account.id, { provider_folder_id: 'known-folder' });
    const provider = countingProvider();
    assert.strictEqual(await ensureAccountFolder(repo, stored, provider), 'known-folder');
    assert.strictEqual(provider.calls, 0);
  });
});

describe('resolveDashboardStores folder handling', function() {
  it('hands every concurrent request the same folder, resolved once', async function() {
    const repo = new UserAccountRepository(':memory:');
    const account = repo.createAccount({
      phone_number_hash: 'hash-2',
      status: 'active',
      encrypted_refresh_token: 'token'
    });
    const providers = [];
    const middleware = resolveDashboardStores({
      accountRepo: repo,
      ownerStores: {},
      ownerPlan: {},
      createProvider: () => {
        const provider = countingProvider('shared-folder');
        providers.push(provider);
        return provider;
      },
      createPlan: () => ({})
    });

    function run() {
      const req = { lociIdentity: { role: 'account', accountId: account.id } };
      const res = { status: () => res, json: () => res };
      return new Promise((resolve, reject) => middleware(req, res, err => (err ? reject(err) : resolve(req))));
    }

    await Promise.all([run(), run(), run()]);

    assert.strictEqual(providers.length, 3);
    assert.strictEqual(providers.reduce((total, provider) => total + provider.calls, 0), 1);
    for (const provider of providers) assert.strictEqual(provider.folderId, 'shared-folder');
    assert.strictEqual(repo.findById(account.id).provider_folder_id, 'shared-folder');
  });
});
