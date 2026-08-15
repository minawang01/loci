const crypto = require('crypto');

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Unambiguous alphabet: no O/0, I/1 or U, so a code read off a screen or over
// the phone can't be mistyped into another valid-looking one.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTVWXYZ23456789';

function generateCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function canonical(code) {
  const bare = normalizeCode(code);
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}

function mintInvite(repo, { ttlMs = INVITE_TTL_MS, note = null } = {}) {
  const code = generateCode();
  return repo.createInvite({ code, expires_at: new Date(Date.now() + ttlMs).toISOString(), note });
}

// The invite a number may sign up with, or null. An invite is single-use, and
// once a number has spent a code request against it it belongs to that number
// alone — so a person who mistypes their number can't be locked out by someone
// else picking the code up, and a resend re-uses the same invite.
function usableInvite(repo, code, phoneHash) {
  const invite = repo.findInvite(canonical(code));
  if (!invite) return null;
  if (invite.redeemed_at) return null;
  if (new Date(invite.expires_at) < new Date()) return null;
  if (invite.phone_number_hash && invite.phone_number_hash !== phoneHash) return null;
  return invite;
}

// Binds the invite to the number a code was just sent to. Deliberately does not
// consume it: the person still has to enter the code, and a code that never
// arrives shouldn't burn the invite.
function reserveInvite(repo, code, phoneHash) {
  return repo.updateInvite(canonical(code), { phone_number_hash: phoneHash });
}

function redeemInvite(repo, code, phoneHash) {
  return repo.updateInvite(canonical(code), {
    phone_number_hash: phoneHash,
    redeemed_at: new Date().toISOString()
  });
}

module.exports = {
  INVITE_TTL_MS,
  canonical,
  generateCode,
  mintInvite,
  normalizeCode,
  redeemInvite,
  reserveInvite,
  usableInvite
};
