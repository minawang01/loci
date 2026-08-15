const { decryptToken } = require('../tokenCrypto');
const GoogleDriveProvider = require('../storage/GoogleDriveProvider');
const { buildStores } = require('../stores');

function createDriveProvider(account) {
  return new GoogleDriveProvider({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: decryptToken(account.encrypted_refresh_token),
    folderId: account.provider_folder_id || null
  });
}

// A claimed account's own storage bundle, built fresh per request: both the
// inbound SMS path and the dashboard need it, and neither may cache it across
// requests (the account's status can be revoked at any time). `createProvider`
// exists so tests can swap in a stub provider instead of a real Drive client.
function buildAccountStores(account, createProvider = createDriveProvider) {
  const provider = createProvider(account);
  return { provider, stores: buildStores(provider) };
}

module.exports = { buildAccountStores, createDriveProvider };
