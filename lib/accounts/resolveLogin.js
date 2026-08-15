const { normalizePhone, hashPhone } = require('../phone');

// Maps a phone number that just proved ownership of itself (via OTP) to the
// dashboard identity it may sign in as, or null when it may not sign in:
// - the owner number, and any LOGIN_PHONE_NUMBERS entry, get the owner view
//   (legacy/admin numbers behave exactly as they did before per-account views)
// - a number with an active, Drive-linked claimed account gets its own view;
//   claiming Drive access is what grants dashboard access, with no allowlisting
function resolveLoginIdentity({ phone, accountRepo, ownerPhone, loginPhoneNumbers = [] }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const ownerNormalized = normalizePhone(ownerPhone);
  if (ownerNormalized && normalized === ownerNormalized) return { role: 'owner' };

  const allowed = loginPhoneNumbers.map(entry => normalizePhone(entry)).filter(Boolean);
  if (allowed.includes(normalized)) return { role: 'owner' };

  // Without the hash secret there is no way to look an account up, and no
  // account could have been claimed in the first place.
  if (!accountRepo || !process.env.ACCOUNT_HASH_SECRET) return null;

  const account = accountRepo.findByPhoneHash(hashPhone(normalized));
  if (!account || account.status !== 'active' || !account.encrypted_refresh_token) return null;
  return { role: 'account', accountId: account.id };
}

module.exports = { resolveLoginIdentity };
