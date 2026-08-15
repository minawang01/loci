const { normalizePhone, hashPhone } = require('../phone');
const { buildAccountStores } = require('./buildAccountStores');
const { ensureAccountFolder } = require('./ensureFolder');
const { PENDING_STATUS } = require('./accountState');

// Where an unrecognised sender is pointed. Replying with a claim link would
// hand out an account to whoever texts in, no invite and no verification code —
// the same hole that makes minting claim links owner-only — so the reply names
// the sign-up page instead and nothing is written for the number.
function signupUrl(publicUrl) {
  return `${(publicUrl || '').replace(/\/$/, '')}/login`;
}

// Routes an inbound SMS sender to the storage they should read/write:
// - the configured owner number always gets `ownerStores` (local disk)
// - a phone linked to an active Google Drive account gets its own stores,
//   built fresh for this request
// - anyone else is pointed at sign-up and nothing is saved
async function resolveSender({ fromNumber, accountRepo, ownerStores, ownerPhone, publicUrl }) {
  const normalized = normalizePhone(fromNumber);
  if (!normalized) return { kind: 'invalid' };

  const ownerNormalized = normalizePhone(ownerPhone);
  if (ownerNormalized && normalized === ownerNormalized) {
    return { kind: 'owner', stores: ownerStores };
  }

  const phoneHash = hashPhone(normalized);
  const account = accountRepo.findByPhoneHash(phoneHash);
  if (!account || account.status !== 'active' || !account.encrypted_refresh_token) {
    return {
      kind: 'unclaimed',
      signupUrl: signupUrl(publicUrl),
      onboarding: Boolean(account && account.status === PENDING_STATUS)
    };
  }

  const { provider, stores } = buildAccountStores(account);

  // First message after claiming: resolve (and persist) the Drive folder id
  // once so every later message skips the list/create round trip.
  const folderId = await ensureAccountFolder(accountRepo, account, provider);
  if (folderId) provider.folderId = folderId;
  accountRepo.updateAccount(account.id, { last_active_at: new Date().toISOString() });

  return { kind: 'active', stores, account };
}

module.exports = { resolveSender };
