require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');
const { basicAuth } = require('./lib/auth');
const { DATA_DIR, ensureDataDir } = require('./lib/paths');

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

app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(bodyParser.json());

app.get('/health', (req, res) => res.json({ ok: true }));

// Twilio authenticates itself with a request signature, so the webhook sits in
// front of the basic-auth gate that protects everything else.
app.use('/webhook', webhookRoutes);

app.use('/api', basicAuth, apiRoutes);
app.use(basicAuth, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Mindchuk server running on port ${PORT}`);
  console.log(`Notes and tags are stored in ${DATA_DIR}`);
  const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  console.log(`Twilio webhook URL to configure: ${publicUrl.replace(/\/$/, '')}/webhook/sms`);
});
