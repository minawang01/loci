// An account is usable once it is active and holds a refresh token for the
// Drive its notes live in — until then there is no storage to read or write.
function isConnected(account) {
  return Boolean(account && account.status === 'active' && account.encrypted_refresh_token);
}

// A number that has verified itself but not yet connected Drive. Such a session
// is genuinely authenticated, so it is not sent back to the login page; it is
// held on the onboarding page until it finishes connecting.
function isOnboarding(account) {
  return Boolean(account && account.status === 'pending');
}

module.exports = { PENDING_STATUS: 'pending', isConnected, isOnboarding };
