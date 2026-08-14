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

const OWNER_IDENTITY = { role: 'owner' };

// A session carries who it belongs to: the owner (local-disk stores) or one
// claimed account (its own Drive-backed stores), referenced by account id.
function encodeIdentity(identity) {
  if (identity && identity.role === 'account') {
    return { role: 'account', ref: String(identity.accountId) };
  }
  return { role: 'owner', ref: '' };
}

// The session cookie is signed with the dashboard password itself, so changing
// the password invalidates every outstanding session. The identity is part of
// the signed payload, so a session cannot be re-pointed at another account.
function signSession(issuedAt, identity, password) {
  const { role, ref } = encodeIdentity(identity);
  return crypto
    .createHmac('sha256', password)
    .update(`${expectedUser()}.${issuedAt}.${role}.${ref}`)
    .digest('hex');
}

function issueSession(password, identity = OWNER_IDENTITY) {
  const issuedAt = Date.now();
  const { role, ref } = encodeIdentity(identity);
  return `${issuedAt}.${role}.${ref}.${signSession(issuedAt, identity, password)}`;
}

// Returns the identity the token attests to, or null when it is malformed,
// expired, mis-signed — or in the pre-identity format, which no longer parses.
function parseSession(token, password) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [issuedAt, role, ref, signature] = parts;
  if (!issuedAt || !signature) return null;
  if (Date.now() - Number(issuedAt) > SESSION_TTL_MS) return null;

  if (role !== 'owner' && role !== 'account') return null;
  const identity =
    role === 'account' ? { role: 'account', accountId: Number(ref) } : OWNER_IDENTITY;
  if (role === 'account' && !Number.isInteger(identity.accountId)) return null;
  if (!safeEqual(signature, signSession(issuedAt, identity, password))) return null;
  return identity;
}

function credentialsMatch(user, password) {
  const expected = process.env.DASHBOARD_PASSWORD;
  return Boolean(expected) && safeEqual(user, expectedUser()) && safeEqual(password, expected);
}

function setSessionCookie(res, password, identity = OWNER_IDENTITY) {
  const parts = [
    `${COOKIE_NAME}=${issueSession(password, identity)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_MS / 1000}`
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

// Browsers send Sec-Fetch-* on every request; scripts and curl do not. Header
// credentials are honoured only for the latter, because a browser that once saw
// a basic-auth prompt on this origin keeps replaying the Authorization header —
// which would silently re-authenticate the user straight after signing out.
function isBrowserRequest(req) {
  return Boolean(req.headers['sec-fetch-mode'] || req.headers['sec-fetch-site']);
}

// The identity behind a request, or null when it is not authenticated. Only a
// session cookie can name an account: header and basic-auth credentials have no
// phone number to derive an identity from, so they act as the owner.
function getIdentity(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return OWNER_IDENTITY; // gate is disabled outside production when unset

  const cookies = parseCookies(req.headers.cookie);
  const session = parseSession(cookies[COOKIE_NAME], password);
  if (session) return session;
  if (isBrowserRequest(req)) return null;

  const secretHeader = req.headers['x-dashboard-secret'];
  if (typeof secretHeader === 'string' && safeEqual(secretHeader, password)) return OWNER_IDENTITY;

  const credentials = parseBasicAuth(req.headers.authorization);
  if (credentials && credentialsMatch(credentials.user, credentials.password)) return OWNER_IDENTITY;
  return null;
}

function isAuthenticated(req) {
  return Boolean(getIdentity(req));
}

// Gates the dashboard and JSON API. Browsers get sent to the login page;
// scripted clients can still authenticate per-request with basic auth or an
// "x-dashboard-secret" header. No WWW-Authenticate is sent, deliberately —
// it would make browsers pop up their own credential dialog over the page.
function requireAuth(req, res, next) {
  if (!process.env.DASHBOARD_PASSWORD && process.env.NODE_ENV === 'production') {
    return res.status(503).send('DASHBOARD_PASSWORD is not configured');
  }
  const identity = getIdentity(req);
  if (identity) {
    req.lociIdentity = identity;
    return next();
  }

  const wantsHtml = (req.headers.accept || '').includes('text/html');
  if (wantsHtml && req.method === 'GET') return res.redirect('/login');
  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = {
  requireAuth,
  isAuthenticated,
  getIdentity,
  credentialsMatch,
  issueSession,
  parseSession,
  setSessionCookie,
  clearSessionCookie,
  COOKIE_NAME
};
