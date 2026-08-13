const twilio = require('twilio');
const { normalizePhone } = require('./phone');

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
