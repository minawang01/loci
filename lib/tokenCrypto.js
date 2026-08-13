const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV size for GCM

function key() {
  const configured = process.env.TOKEN_ENCRYPTION_KEY;
  if (!configured) throw new Error('TOKEN_ENCRYPTION_KEY is not configured');
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes (base64-encoded)');
  }
  return key;
}

// Stores iv, authTag and ciphertext together so the column stays a single
// opaque string — no schema change needed for the existing
// `encrypted_refresh_token` field.
function encryptToken(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map(buf => buf.toString('base64')).join(':');
}

function decryptToken(stored) {
  const [ivB64, authTagB64, ciphertextB64] = String(stored || '').split(':');
  if (!ivB64 || !authTagB64 || !ciphertextB64) throw new Error('malformed encrypted token');

  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

module.exports = { encryptToken, decryptToken };
