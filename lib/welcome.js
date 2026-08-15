// The first text a new account gets, mirroring the instructions shown on the
// onboarding page so both say the same thing.
const WELCOME_LINES = [
  'Welcome to loci.',
  '',
  'Text this number anything you want to remember and it lands in your own Google Drive.',
  '',
  'Try:',
  '  a note — "parked in level 3, row F"',
  '  #todo book the dentist',
  '  #done book the dentist',
  '  #busy 9am-5pm work',
  '  #goals run a half marathon',
  '',
  'Text #help any time for the full list.'
];

function welcomeMessage() {
  return WELCOME_LINES.join('\n');
}

// Attempts the welcome text and reports whether it went out. Sending is best
// effort on purpose: the number this app sends from is still pending A2P 10DLC
// registration, so delivery can fail for reasons the new user can do nothing
// about, and onboarding has already succeeded by the time this runs. The page
// carries the same instructions either way.
async function sendWelcome(sms, phone) {
  if (!phone) return false;
  if (!sms || !sms.canSend(phone)) {
    console.warn('Skipped welcome text: outbound messaging is not configured');
    return false;
  }
  try {
    await sms.sendMessage(phone, welcomeMessage());
    return true;
  } catch (err) {
    console.error('Failed to send welcome text:', err.message);
    return false;
  }
}

module.exports = { WELCOME_LINES, welcomeMessage, sendWelcome };
