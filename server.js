require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');
const {
  requireAuth,
  isAuthenticated,
  credentialsMatch,
  setSessionCookie,
  clearSessionCookie
} = require('./lib/auth');
const { DATA_DIR, ensureDataDir } = require('./lib/paths');
const { startBackups } = require('./lib/backup');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Required for correct client IPs (rate limiting) and https URLs behind the
// TLS-terminating proxy every managed host puts in front of the app.
app.set('trust proxy', 1);

function assertProductionConfig() {
  const missing = ['TWILIO_AUTH_TOKEN', 'PUBLIC_URL', 'DASHBOARD_PASSWORD'].filter(
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
ensureDataDir();
startBackups();

app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(bodyParser.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Twilio authenticates itself with a request signature, so the webhook sits in
// front of the basic-auth gate that protects everything else.
app.use('/webhook', webhookRoutes);

// The login page is the only thing served before the gate, so an unauthenticated
// visitor never sees any part of the dashboard.
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

app.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use('/api', requireAuth, apiRoutes);
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Loci server running on port ${PORT}`);
  console.log(`Notes and tags are stored in ${DATA_DIR}`);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`Twilio webhook URL to configure: ${publicUrl.replace(/\/$/, '')}/webhook/sms`);
});
