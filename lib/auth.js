const crypto = require('crypto');

const REALM = 'mindchuk';

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseBasicAuth(header) {
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

// Gates the dashboard and JSON API behind HTTP basic auth. A shared secret can
// also be passed as an "x-dashboard-secret" header for scripted access.
function basicAuth(req, res, next) {
  const expectedUser = process.env.DASHBOARD_USER || 'mindchuk';
  const expectedPassword = process.env.DASHBOARD_PASSWORD;

  if (!expectedPassword) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).send('DASHBOARD_PASSWORD is not configured');
    }
    return next();
  }

  const secretHeader = req.headers['x-dashboard-secret'];
  if (typeof secretHeader === 'string' && safeEqual(secretHeader, expectedPassword)) {
    return next();
  }

  const credentials = parseBasicAuth(req.headers.authorization);
  if (
    credentials &&
    safeEqual(credentials.user, expectedUser) &&
    safeEqual(credentials.password, expectedPassword)
  ) {
    return next();
  }

  res.set('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
  return res.status(401).send('Authentication required');
}

module.exports = { basicAuth };
