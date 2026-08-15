const { isOnboarding } = require('./accountState');

// Keeps a session that has verified its number but not yet connected Drive on
// the onboarding page. Without this the dashboard would load for an account
// with no storage behind it and fail on every tab.
function onboardingGate({ accountRepo }) {
  return function gate(req, res, next) {
    const identity = req.lociIdentity;
    if (!identity || identity.role !== 'account') return next();
    if (!isOnboarding(accountRepo && accountRepo.findById(identity.accountId))) return next();

    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (wantsHtml && req.method === 'GET') return res.redirect('/onboarding');
    return res
      .status(403)
      .json({ error: 'Connect your Google Drive to start saving notes', onboarding: true });
  };
}

module.exports = { onboardingGate };
