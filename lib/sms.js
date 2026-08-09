const twilio = require('twilio');

let cachedClient = null;

function client() {
  if (!cachedClient) {
    cachedClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return cachedClient;
}

// A "whatsapp:" recipient has to be sent from the WhatsApp sender, not the SMS
// one, so the channel is inferred from the destination rather than configured
// separately.
function senderFor(to) {
  return to.startsWith('whatsapp:')
    ? process.env.TWILIO_WHATSAPP_NUMBER
    : process.env.TWILIO_SMS_NUMBER;
}

function canSend(to) {
  return Boolean(
    to && senderFor(to) && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  );
}

// Twilio accepts the message and reports delivery failures asynchronously, so a
// resolved promise means "handed off", not "arrived on the handset".
async function sendMessage(to, body) {
  const message = await client().messages.create({ from: senderFor(to), to, body });
  return message.sid;
}

module.exports = { canSend, sendMessage, senderFor };
