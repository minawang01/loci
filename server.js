require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const createWebhookRouter = require('./routes/webhook');
const createApiRouter = require('./routes/api');
const {
  requireAuth,
  isAuthenticated,
  credentialsMatch,
  setSessionCookie,
  clearSessionCookie
} = require('./lib/auth');
const otp = require('./lib/otp');
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

// The login page is the only other thing served before the gate, so an
// unauthenticated visitor never sees any part of the dashboard.
app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username = '', password = '' } = req.body;
  if (!credentialsMatch(username, password)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  setSessionCookie(res, password);
  res.json({ ok: true });
});

// Lets the login page hide the phone tab on deployments without Verify
// configured. Deliberately says nothing about which numbers are allowed.
app.get('/login/options', (req, res) => res.json({ otp: otp.otpEnabled() }));

// Each code costs money to send and is a chance to guess, so both halves of the
// flow are capped well below anything a real person needs.
const otpStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many codes requested. Try again in a few minutes.' }
});

const otpCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' }
});

app.post('/login/otp/start', otpStartLimiter, async (req, res) => {
  if (!otp.otpEnabled()) return res.status(404).json({ error: 'Phone sign-in is not configured' });

  const phone = otp.normalizePhone(req.body.phone);
  // Always answer as if the code was sent: telling a stranger which numbers are
  // on the allowlist would hand them half the credential.
  if (!otp.isAllowed(phone)) return res.json({ ok: true });

  try {
    await otp.sendCode(phone);
  } catch (err) {
    console.error('Failed to send verification code:', err.message);
    return res.status(502).json({ error: 'Could not send a code. Try again shortly.' });
  }
  res.json({ ok: true });
});

app.post('/login/otp/check', otpCheckLimiter, async (req, res) => {
  if (!otp.otpEnabled()) return res.status(404).json({ error: 'Phone sign-in is not configured' });

  const phone = otp.normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  const rejected = { error: 'That code is not valid' };
  if (!otp.isAllowed(phone) || !/^\d{4,10}$/.test(code)) return res.status(401).json(rejected);

  let approved = false;
  try {
    approved = await otp.checkCode(phone, code);
  } catch (err) {
    console.error('Failed to check verification code:', err.message);
    return res.status(502).json({ error: 'Could not check that code. Try again shortly.' });
  }
  if (!approved) return res.status(401).json(rejected);

  setSessionCookie(res, process.env.DASHBOARD_PASSWORD || '');
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use('/api', requireAuth, createApiRouter(ownerStores, { plan, sms }));
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Loci server running on port ${PORT}`);
  console.log(`Notes and tags are stored in ${DATA_DIR}`);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`Twilio webhook URL to configure: ${publicUrl.replace(/\/$/, '')}/webhook/sms`);
});
