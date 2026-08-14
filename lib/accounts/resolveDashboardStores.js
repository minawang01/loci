const { clearSessionCookie } = require('../auth');
const { buildAccountStores } = require('./buildAccountStores');
const createPlanModule = require('../plan');

// Binds a dashboard request to the storage its session owns, so every /api
// handler reads `req.stores`/`req.plan` rather than one process-wide bundle.
// An account session is re-checked against the database on every request: no
// account state is trusted from login time, so revoking an account cuts its
// dashboard access on its very next call.
// `createProvider`/`createPlan` are injection points for tests; real usage
// omits them and gets a Google Drive provider and the real plan module.
function resolveDashboardStores({
  accountRepo,
  ownerStores,
  ownerPlan,
  createProvider,
  createPlan = createPlanModule
}) {
  return function dashboardStores(req, res, next) {
    const identity = req.lociIdentity || { role: 'owner' };

    if (identity.role !== 'account') {
      req.stores = ownerStores;
      req.plan = ownerPlan;
      return next();
    }

    const account = accountRepo && accountRepo.findById(identity.accountId);
    if (!account || account.status !== 'active' || !account.encrypted_refresh_token) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const { stores } = buildAccountStores(account, createProvider);
      req.stores = stores;
      // Cheap: the factory only closes over the stores, with no I/O.
      req.plan = createPlan(stores);
    } catch (err) {
      console.error('Could not open account storage:', err.message);
      return res.status(500).json({ error: 'Could not open your storage' });
    }
    next();
  };
}

module.exports = { resolveDashboardStores };
