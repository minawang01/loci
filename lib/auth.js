const crypto = require('crypto');

const COOKIE_NAME = 'loci_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function expectedUser() {
  return process.env.DASHBOARD_USER || 'loci';
}

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

function parseCookies(header) {
  const jar = {};
  (header || '').split(';').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return;
    jar[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
  });
  return jar;
}

// The session cookie is signed with the dashboard password itself, so changing
// the password invalidates every outstanding session.
function signSession(issuedAt, password) {
  return crypto
    .createHmac('sha256', password)
    .update(`${expectedUser()}.${issuedAt}`)
    .digest('hex');
}

function issueSession(password) {
  const issuedAt = Date.now();
  return `${issuedAt}.${signSession(issuedAt, password)}`;
}

function validSession(token, password) {
  if (typeof token !== 'string') return false;
  const [issuedAt, signature] = token.split('.');
  if (!issuedAt || !signature) return false;
  if (Date.now() - Number(issuedAt) > SESSION_TTL_MS) return false;
  return safeEqual(signature, signSession(issuedAt, password));
}

function credentialsMatch(user, password) {
  const expected = process.env.DASHBOARD_PASSWORD;
  return Boolean(expected) && safeEqual(user, expectedUser()) && safeEqual(password, expected);
}

function setSessionCookie(res, password) {
  const parts = [
    `${COOKIE_NAME}=${issueSession(password)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_MS / 1000}`
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.set('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isAuthenticated(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return true; // gate is disabled outside production when unset

  const cookies = parseCookies(req.headers.cookie);
  if (validSession(cookies[COOKIE_NAME], password)) return true;

  const secretHeader = req.headers['x-dashboard-secret'];
  if (typeof secretHeader === 'string' && safeEqual(secretHeader, password)) return true;

  const credentials = parseBasicAuth(req.headers.authorization);
  return Boolean(credentials && credentialsMatch(credentials.user, credentials.password));
}

// Gates the dashboard and JSON API. Browsers get sent to the login page;
// scripted clients can still authenticate per-request with basic auth or an
// "x-dashboard-secret" header. No WWW-Authenticate is sent, deliberately —
// it would make browsers pop up their own credential dialog over the page.
function requireAuth(req, res, next) {
  if (!process.env.DASHBOARD_PASSWORD && process.env.NODE_ENV === 'production') {
    return res.status(503).send('DASHBOARD_PASSWORD is not configured');
  }
  if (isAuthenticated(req)) return next();

  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (wantsHtml && req.method === 'GET') return res.redirect('/login');
  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = {
  requireAuth,
  isAuthenticated,
  credentialsMatch,
  setSessionCookie,
  clearSessionCookie
};
