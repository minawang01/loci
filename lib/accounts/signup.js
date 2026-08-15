const { hashPhone } = require('../phone');
const { PENDING_STATUS, isConnected } = require('./accountState');

function signupConfigured() {
  return Boolean(process.env.ACCOUNT_HASH_SECRET && process.env.TOKEN_ENCRYPTION_KEY);
}

// Cutting an account off is documented as setting its status to anything but
// `active`, so signing up again must be barred by the same rule rather than by
// the one word `revoked` — otherwise any other status is a way back in. Only
// the states that precede having storage may sign up.
const SIGNUP_STATUSES = ['active', PENDING_STATUS, 'unclaimed'];

function signupBlocked(account) {
  return Boolean(account && !SIGNUP_STATUSES.includes(account.status));
}

// The account row a freshly verified number signs in as, before it has storage.
// It exists only so the session has something to point at; it stays `pending`,
// and therefore unusable for notes, until Drive is connected.
function ensurePendingAccount(accountRepo, phone) {
  const phoneHash = hashPhone(phone);
  const existing = accountRepo.findByPhoneHash(phoneHash);
  if (signupBlocked(existing)) return null;
  if (existing) {
    // Never walk a working account backwards into onboarding.
    if (isConnected(existing)) return existing;
    return existing.status === PENDING_STATUS
      ? existing
      : accountRepo.updateAccount(existing.id, { status: PENDING_STATUS });
  }
  return accountRepo.createAccount({
    phone_number_hash: phoneHash,
    storage_provider: 'google_drive',
    status: PENDING_STATUS
  });
}

module.exports = { ensurePendingAccount, signupBlocked, signupConfigured };
