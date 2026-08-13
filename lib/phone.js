const crypto = require('crypto');

// Accepts what a person actually types — "(402) 417-0066", "402 417 0066",
// "+1 402-417-0066" — and returns E.164, assuming US when no country code.
function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function hashSecret() {
  const secret = process.env.ACCOUNT_HASH_SECRET;
  if (!secret) throw new Error('ACCOUNT_HASH_SECRET is not configured');
  return secret;
}

// A stable, non-reversible identifier for a phone number, used as the lookup
// key for user_accounts so the number itself is never stored in the clear.
function hashPhone(e164) {
  return crypto.createHmac('sha256', hashSecret()).update(e164).digest('hex');
}

module.exports = { normalizePhone, hashPhone };
