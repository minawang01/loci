const assert = require('assert');
const { issueSession, parseSession } = require('../lib/auth');

describe('session tokens', function() {
  const password = 'dashboard-password';

  it('round trips an owner session', function() {
    const identity = parseSession(issueSession(password, { role: 'owner' }), password);
    assert.deepStrictEqual(identity, { role: 'owner' });
  });

  it('round trips an account session, keeping the account id', function() {
    const identity = parseSession(issueSession(password, { role: 'account', accountId: 7 }), password);
    assert.deepStrictEqual(identity, { role: 'account', accountId: 7 });
  });

  it('defaults to the owner identity when none is given', function() {
    assert.deepStrictEqual(parseSession(issueSession(password), password), { role: 'owner' });
  });

  it('rejects a token signed with another password', function() {
    assert.strictEqual(parseSession(issueSession('other-password'), password), null);
  });

  it('rejects a tampered signature', function() {
    const token = issueSession(password, { role: 'account', accountId: 7 });
    const parts = token.split('.');
    parts[3] = parts[3].replace(/.$/, char => (char === 'a' ? 'b' : 'a'));
    assert.strictEqual(parseSession(parts.join('.'), password), null);
  });

  // The whole point of signing the identity: swapping the account id in a
  // stolen cookie must not hand over someone else's notes.
  it('rejects a session repointed at a different account', function() {
    const [issuedAt, , , signature] = issueSession(password, { role: 'account', accountId: 7 }).split('.');
    assert.strictEqual(parseSession(`${issuedAt}.account.8.${signature}`, password), null);
    assert.strictEqual(parseSession(`${issuedAt}.owner..${signature}`, password), null);
  });

  it('rejects an expired token', function() {
    const token = issueSession(password, { role: 'owner' });
    const [, role, ref, signature] = token.split('.');
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    assert.strictEqual(parseSession(`${old}.${role}.${ref}.${signature}`, password), null);
  });

  it('rejects an unknown role', function() {
    assert.strictEqual(parseSession(`${Date.now()}.admin..deadbeef`, password), null);
  });

  // Pre-change cookies are "<issuedAt>.<signature>"; they must fail outright
  // rather than fall back to some default identity.
  it('rejects a pre-identity token instead of assuming an identity', function() {
    const crypto = require('crypto');
    const issuedAt = Date.now();
    const legacy = crypto
      .createHmac('sha256', password)
      .update(`loci.${issuedAt}`)
      .digest('hex');
    assert.strictEqual(parseSession(`${issuedAt}.${legacy}`, password), null);
  });
});
