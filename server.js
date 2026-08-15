require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const createWebhookRouter = require('./routes/webhook');
const createApiRouter = require('./routes/api');
const createLoginRouter = require('./routes/login');
const createOnboardingRouter = require('./routes/onboarding');
const createInvitesRouter = require('./routes/invites');
const { requireAuth, clearSessionCookie } = require('./lib/auth');
const otp = require('./lib/otp');
const { resolveDashboardStores } = require('./lib/accounts/resolveDashboardStores');
const { onboardingGate } = require('./lib/accounts/onboardingGate');
const { createVerifiedPhoneStore } = require('./lib/accounts/verifiedPhones');
const { DATA_DIR } = require('./lib/paths');
const LocalFileStorageProvider = require('./lib/storage/LocalFileStorageProvider');
const { buildStores } = require('./lib/stores');
const createPlanModule = require('./lib/plan');
const sms = require('./lib/sms');
const createClaimRouter = require('./routes/claim');

const storageProvider = new LocalFileStorageProvider();
const { startBackups } = require('./lib/backup');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Required for correct client IPs (rate limiting) and https URLs behind the
// TLS-terminating proxy every managed host puts in front of the app.
app.set('trust proxy', 1);

function assertProductionConfig() {
  const missing = ['TWILIO_AUTH_TOKEN', 'PUBLIC_URL', 'DASHBOARD_PASSWORD', 'OWNER_PHONE_NUMBER'].filter(
    key => !process.env[key]
  );
  if (missing.length) {
    console.error(
      `Refusing to start in production without: ${missing.join(', ')}. ` +
        'See .env.example for what each variable does.'
    );
    process.exit(1);
  }
  if (process.env.SKIP_TWILIO_VALIDATION === 'true') {
    console.error('SKIP_TWILIO_VALIDATION cannot be used when NODE_ENV=production.');
    process.exit(1);
  }
}

if (IS_PRODUCTION) assertProductionConfig();
storageProvider.ensureDataDir && storageProvider.ensureDataDir();
// The owner (OWNER_PHONE_NUMBER) always reads/writes local disk through this
// bundle. Everyone else who texts in gets their own bundle bound to their
// linked Google Drive — see lib/accounts/resolveSender.js.
const ownerStores = buildStores(storageProvider);
const plan = createPlanModule(ownerStores);
const UserAccountRepository = require('./lib/accounts/UserAccountRepository');
const accountRepo = new UserAccountRepository();
const verifiedPhones = createVerifiedPhoneStore();
startBackups();
plan.startPlanScheduler();

app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(bodyParser.json());

app.use('/claim', createClaimRouter(accountRepo));

app.get('/health', (req, res) => res.json({ ok: true }));

// Twilio authenticates itself with a request signature, so the webhook sits in
// front of the basic-auth gate that protects everything else.
app.use(
  '/webhook',
  createWebhookRouter({ accountRepo, ownerStores, ownerPhone: process.env.OWNER_PHONE_NUMBER })
);

// A2P 10DLC campaign registration requires a publicly reachable privacy policy
// and terms, so these two sit outside the auth gate. They describe the app, not
// its contents, and expose nothing about the notes.
for (const page of ['privacy', 'terms']) {
  app.get(`/${page}`, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', `${page}.html`))
  );
}

// The claim page is how someone who has never touched the dashboard links
// their own Google account, so it has to be reachable without a dashboard
// session — gating it behind requireAuth would make the claim link useless
// to anyone but the owner.
app.get('/claim.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'claim.html'));
});

// Sign-in and invite-gated sign-up. Served before the gate, so an
// unauthenticated visitor never sees any part of the dashboard.
app.use('/login', createLoginRouter({ accountRepo, otp, verifiedPhones }));

app.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Onboarding sits behind the gate but in front of the dashboard: the session it
// serves is authenticated and has no storage yet.
app.use('/onboarding', requireAuth, createOnboardingRouter({ accountRepo, verifiedPhones, sms }));

app.use('/invites', requireAuth, createInvitesRouter({ accountRepo }));

app.use(
  '/api',
  requireAuth,
  resolveDashboardStores({ accountRepo, ownerStores, ownerPlan: plan }),
  createApiRouter({ sms })
);
app.use(requireAuth, onboardingGate({ accountRepo }), express.static(path.join(__dirname, 'public')));

// Last resort: a handler that threw answers 500 instead of leaving the request
// hanging, and the process stays up.
app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`Loci server running on port ${PORT}`);
  console.log(`Notes and tags are stored in ${DATA_DIR}`);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`Twilio webhook URL to configure: ${publicUrl.replace(/\/$/, '')}/webhook/sms`);
});
