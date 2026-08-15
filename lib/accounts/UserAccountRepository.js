const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('../paths');

const DB_PATH = process.env.ACCOUNTS_DB || path.join(DATA_DIR, 'accounts.db');

class UserAccountRepository {
  constructor(dbPath) {
    this.dbPath = dbPath || DB_PATH;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this._init();
  }

  _init() {
    const createUsers = `
      CREATE TABLE IF NOT EXISTS user_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone_number_hash TEXT UNIQUE,
        storage_provider TEXT,
        encrypted_refresh_token TEXT,
        provider_folder_id TEXT,
        claimed_at TEXT,
        last_active_at TEXT,
        status TEXT
      );
    `;
    const createTokens = `
      CREATE TABLE IF NOT EXISTS claim_tokens (
        token TEXT PRIMARY KEY,
        phone_number_hash TEXT,
        expires_at TEXT
      );
    `;
    // Sign-up is invite-only: every verification code costs money to send, so
    // an unknown number gets one only against an invite the owner minted.
    // `phone_number_hash` is stamped on first use, which binds the invite to
    // that number and stops a leaked code being spent by anyone else.
    const createInvites = `
      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        created_at TEXT,
        expires_at TEXT,
        phone_number_hash TEXT,
        redeemed_at TEXT,
        note TEXT
      );
    `;
    this.db.exec(createUsers);
    this.db.exec(createTokens);
    this.db.exec(createInvites);
  }

  createAccount({ phone_number_hash, storage_provider = 'google_drive', encrypted_refresh_token = null, provider_folder_id = null, claimed_at = null, last_active_at = null, status = 'unclaimed' }) {
    const stmt = this.db.prepare(`INSERT INTO user_accounts (phone_number_hash, storage_provider, encrypted_refresh_token, provider_folder_id, claimed_at, last_active_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(phone_number_hash, storage_provider, encrypted_refresh_token, provider_folder_id, claimed_at, last_active_at, status);
    return this.findById(info.lastInsertRowid);
  }

  findByPhoneHash(hash) {
    const stmt = this.db.prepare(`SELECT * FROM user_accounts WHERE phone_number_hash = ?`);
    return stmt.get(hash) || null;
  }

  findById(id) {
    const stmt = this.db.prepare(`SELECT * FROM user_accounts WHERE id = ?`);
    return stmt.get(id) || null;
  }

  updateAccount(id, updates) {
    const keys = Object.keys(updates);
    if (!keys.length) return this.findById(id);
    const sets = keys.map(k => `${k} = ?`).join(', ');
    const stmt = this.db.prepare(`UPDATE user_accounts SET ${sets} WHERE id = ?`);
    const params = keys.map(k => updates[k]);
    params.push(id);
    stmt.run(...params);
    return this.findById(id);
  }

  // Claim tokens
  createClaimToken(token, phone_number_hash, expires_at) {
    const stmt = this.db.prepare(`INSERT INTO claim_tokens (token, phone_number_hash, expires_at) VALUES (?, ?, ?)`);
    stmt.run(token, phone_number_hash, expires_at);
    return { token, phone_number_hash, expires_at };
  }

  findClaimToken(token) {
    const stmt = this.db.prepare(`SELECT * FROM claim_tokens WHERE token = ?`);
    return stmt.get(token) || null;
  }

  // Most recent unexpired token for a phone hash, so a number that texts in
  // more than once before claiming gets the same link back instead of a new
  // one every time.
  findActiveClaimTokenByPhoneHash(hash) {
    const stmt = this.db.prepare(
      `SELECT * FROM claim_tokens WHERE phone_number_hash = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`
    );
    return stmt.get(hash, new Date().toISOString()) || null;
  }

  deleteClaimToken(token) {
    const stmt = this.db.prepare(`DELETE FROM claim_tokens WHERE token = ?`);
    stmt.run(token);
  }

  // Invites
  createInvite({ code, expires_at, note = null }) {
    const stmt = this.db.prepare(
      `INSERT INTO invites (code, created_at, expires_at, phone_number_hash, redeemed_at, note) VALUES (?, ?, ?, NULL, NULL, ?)`
    );
    stmt.run(code, new Date().toISOString(), expires_at, note);
    return this.findInvite(code);
  }

  findInvite(code) {
    const stmt = this.db.prepare(`SELECT * FROM invites WHERE code = ?`);
    return stmt.get(code) || null;
  }

  updateInvite(code, updates) {
    const keys = Object.keys(updates);
    if (!keys.length) return this.findInvite(code);
    const sets = keys.map(key => `${key} = ?`).join(', ');
    const stmt = this.db.prepare(`UPDATE invites SET ${sets} WHERE code = ?`);
    stmt.run(...keys.map(key => updates[key]), code);
    return this.findInvite(code);
  }
}

module.exports = UserAccountRepository;
