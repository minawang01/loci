require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(bodyParser.json());

app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Mindchuk server running on http://localhost:${PORT}`);
  console.log(`Twilio webhook URL to configure: <your public URL>/webhook/sms`);
});
