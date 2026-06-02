import initSqlJs from 'sql.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', 'data.db');

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_premium INTEGER DEFAULT 0,
      premium_until TEXT,
      searches_today INTEGER DEFAULT 0,
      last_search_date TEXT,
      joined_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      query TEXT,
      result_type TEXT,
      result_data TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      tier TEXT,
      payment_method TEXT,
      payment_proof TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const existingPayment = db.exec("SELECT key FROM config WHERE key = 'payment_paypal'");
  if (!existingPayment.length) {
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('payment_paypal', 'off')");
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('payment_paysafecard', 'on')");
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('payment_card', 'off')");
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('daily_limit', '1')");
    db.run("INSERT OR IGNORE INTO config (key, value) VALUES ('paypal_email', 'scarface@example.com')");
  }

  saveDb();
  return db;
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(dbPath, buffer);
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  if (sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('WITH')) {
    const rows = [];
    if (params.length) stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } else {
    stmt.run(params);
    stmt.free();
    saveDb();
    return { changes: db.getRowsModified() };
  }
}

function getOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

// ---- User functions ----

function upsertUser(id, username, first_name, last_name) {
  const existing = getOne('SELECT * FROM users WHERE id = ?', [id]);
  if (existing) {
    query(
      'UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE id = ?',
      [username, first_name, last_name, id]
    );
  } else {
    query(
      'INSERT INTO users (id, username, first_name, last_name) VALUES (?, ?, ?, ?)',
      [id, username, first_name, last_name]
    );
  }
}

function getUser(id) {
  return getOne('SELECT * FROM users WHERE id = ?', [id]);
}

function setPremium(until, id) {
  query('UPDATE users SET is_premium = 1, premium_until = ? WHERE id = ?', [until, id]);
}

function removePremium(id) {
  query('UPDATE users SET is_premium = 0, premium_until = NULL WHERE id = ?', [id]);
}

function incrementSearch(id) {
  query(
    "UPDATE users SET searches_today = searches_today + 1, last_search_date = date('now') WHERE id = ?",
    [id]
  );
}

function resetDailySearches() {
  query("UPDATE users SET searches_today = 0 WHERE last_search_date != date('now') OR last_search_date IS NULL");
}

function saveSearch(user_id, query_text, result_type, result_data) {
  query(
    'INSERT INTO search_history (user_id, query, result_type, result_data) VALUES (?, ?, ?, ?)',
    [user_id, query_text, result_type, result_data]
  );
}

function getSearchHistory(user_id) {
  return query(
    'SELECT * FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [user_id]
  );
}

function getSearchById(id, user_id) {
  return getOne('SELECT * FROM search_history WHERE id = ? AND user_id = ?', [id, user_id]);
}

function deleteSearchHistory(user_id) {
  query('DELETE FROM search_history WHERE user_id = ?', [user_id]);
}

function getAllUsers() {
  return query('SELECT * FROM users ORDER BY joined_at DESC');
}

function getUserCount() {
  return getOne('SELECT COUNT(*) as count FROM users');
}

function getPremiumCount() {
  return getOne('SELECT COUNT(*) as count FROM users WHERE is_premium = 1');
}

function getConfig(key) {
  return getOne('SELECT value FROM config WHERE key = ?', [key]);
}

function setConfig(key, value) {
  const existing = getOne('SELECT * FROM config WHERE key = ?', [key]);
  if (existing) {
    query('UPDATE config SET value = ? WHERE key = ?', [value, key]);
  } else {
    query('INSERT INTO config (key, value) VALUES (?, ?)', [key, value]);
  }
}

function deleteConfig(key) {
  query('DELETE FROM config WHERE key = ?', [key]);
}

function runSql(sql, params = []) {
  return query(sql, params);
}

function createPendingPayment(user_id, username, tier, payment_method, payment_proof) {
  query(
    'INSERT INTO pending_payments (user_id, username, tier, payment_method, payment_proof) VALUES (?, ?, ?, ?, ?)',
    [user_id, username, tier, payment_method, payment_proof]
  );
  const rows = query('SELECT last_insert_rowid() as id');
  return rows[0]?.id;
}

function getPendingPayments(status = 'pending') {
  return query('SELECT * FROM pending_payments WHERE status = ? ORDER BY created_at DESC', [status]);
}

function updatePendingPayment(id, status) {
  query('UPDATE pending_payments SET status = ? WHERE id = ?', [status, id]);
}

function getPendingPaymentByUser(user_id) {
  return getOne('SELECT * FROM pending_payments WHERE user_id = ? AND status = "pending" ORDER BY created_at DESC', [user_id]);
}

export {
  initDb,
  upsertUser,
  getUser,
  setPremium,
  removePremium,
  incrementSearch,
  resetDailySearches,
  saveSearch,
  getSearchHistory,
  getSearchById,
  deleteSearchHistory,
  getAllUsers,
  getUserCount,
  getPremiumCount,
  getConfig,
  setConfig,
  deleteConfig,
  runSql,
  createPendingPayment,
  getPendingPayments,
  updatePendingPayment,
  getPendingPaymentByUser
};
