const twilio = require('twilio');

let cachedClient = null;

function client() {
  if (!cachedClient) {
    cachedClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return cachedClient;
}

// OTP login is off unless a Verify service and an allowlist are both configured,
// so a deployment can never accidentally accept a code from an arbitrary phone.
function otpEnabled() {
  return Boolean(
    process.env.TWILIO_VERIFY_SERVICE_SID &&
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      allowedPhones().length
  );
}

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

function allowedPhones() {
  return (process.env.LOGIN_PHONE_NUMBERS || '')
    .split(',')
    .map(entry => normalizePhone(entry))
    .filter(Boolean);
}

function isAllowed(phone) {
  return Boolean(phone) && allowedPhones().includes(phone);
}

async function sendCode(phone) {
  await client()
    .verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({ to: phone, channel: 'sms' });
}

async function checkCode(phone, code) {
  try {
    const check = await client()
      .verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: phone, code });
    return check.status === 'approved';
  } catch (err) {
    // Twilio 404s the check once a verification has expired or been consumed,
    // which is a wrong-code outcome rather than a server fault.
    if (err && err.status === 404) return false;
    throw err;
  }
}

module.exports = { otpEnabled, normalizePhone, isAllowed, sendCode, checkCode };
