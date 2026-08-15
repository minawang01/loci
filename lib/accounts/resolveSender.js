const crypto = require('crypto');
const { normalizePhone, hashPhone } = require('../phone');
const { buildAccountStores } = require('./buildAccountStores');
const { ensureAccountFolder } = require('./ensureFolder');

const CLAIM_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h, matches routes/claim.js

// Reuses an existing unexpired token for this phone hash when one exists, so
// texting an unclaimed number more than once returns the same link instead
// of spamming a fresh one every time.
function ensureClaimLink({ accountRepo, phoneHash, publicUrl }) {
  const existing = accountRepo.findActiveClaimTokenByPhoneHash(phoneHash);
  const token = existing ? existing.token : createClaimToken(accountRepo, phoneHash);
  return `${(publicUrl || '').replace(/\/$/, '')}/claim.html?token=${token}`;
}

function createClaimToken(accountRepo, phoneHash) {
  const token = crypto.randomBytes(18).toString('hex');
  const expiresAt = new Date(Date.now() + CLAIM_TOKEN_TTL_MS).toISOString();
  accountRepo.createClaimToken(token, phoneHash, expiresAt);
  return token;
}

// Routes an inbound SMS sender to the storage they should read/write:
// - the configured owner number always gets `ownerStores` (local disk)
// - a phone linked to an active Google Drive account gets its own stores,
//   built fresh for this request
// - anyone else gets a claim link and nothing is saved
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
    return { kind: 'unclaimed', claimUrl: ensureClaimLink({ accountRepo, phoneHash, publicUrl }) };
  }

  const { provider, stores } = buildAccountStores(account);

  // First message after claiming: resolve (and persist) the Drive folder id
  // once so every later message skips the list/create round trip.
  const folderId = await ensureAccountFolder(accountRepo, account, provider);
  if (folderId) provider.folderId = folderId;
  accountRepo.updateAccount(account.id, { last_active_at: new Date().toISOString() });

  return { kind: 'active', stores, account };
}

module.exports = { resolveSender, ensureClaimLink };
