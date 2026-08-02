const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const DB_PATH = path.resolve('./kiviomap.db');

let _db = null;

function getDb() { return _db; }

function save() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function runSql(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params.flat());
  else stmt.bind([]);
  stmt.step();
  stmt.free();
}

function queryRows(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params.flat());
  else stmt.bind([]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function tableExists(name) {
  const result = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
  return (result[0]?.values?.length ?? 0) > 0;
}

function getColumnInfo(tableName) {
  const result = _db.exec(`PRAGMA table_info(${tableName})`);
  return result[0]?.values ?? [];
}

function createTables() {
  _db.run(SCHEMA);
  try { _db.run(`ALTER TABLE wifi_points ADD COLUMN anonymous INTEGER DEFAULT 0`); } catch (e) {}
  try { _db.run(`ALTER TABLE wifi_history ADD COLUMN anonymous INTEGER DEFAULT 0`); } catch (e) {}
}

function migrateToUuidSchema() {
  _db.run('PRAGMA foreign_keys = OFF');
  ['users', 'wifi_points', 'verifications', 'votes', 'wifi_history', 'comments', 'password_resets'].forEach(table => {
    if (tableExists(`${table}_old`)) _db.run(`DROP TABLE ${table}_old`);
    if (tableExists(table)) _db.run(`ALTER TABLE ${table} RENAME TO ${table}_old`);
  });

  createTables();

  const userIdMap = new Map();
  for (const row of queryRows('SELECT * FROM users_old')) {
    const id = crypto.randomUUID();
    userIdMap.set(row.id, id);
    runSql(
      `INSERT INTO users (id, username, email, password, points, level, role, banned, session_version, email_verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.username, row.email, row.password, row.points ?? 0, row.level ?? 1, row.role ?? 'member', row.banned ?? 0, row.session_version ?? 0, row.email_verified ?? 0, row.created_at]
    );
  }

  const wifiIdMap = new Map();
  for (const row of queryRows('SELECT * FROM wifi_points_old')) {
    const id = crypto.randomUUID();
    wifiIdMap.set(row.id, id);
    runSql(
      `INSERT INTO wifi_points (id, ssid, password, encryption, captive_portal, gateway, dhcp_range, download_mbps, upload_mbps, ping_ms, isp, place_type, hours, lat, lng, author_id, confidence_score, last_verified, created_at, anonymous)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.ssid, row.password, row.encryption, row.captive_portal ?? 0, row.gateway, row.dhcp_range, row.download_mbps, row.upload_mbps, row.ping_ms, row.isp, row.place_type, row.hours, row.lat, row.lng, row.author_id ? userIdMap.get(row.author_id) ?? row.author_id : null, row.confidence_score ?? 50, row.last_verified, row.created_at, row.anonymous ?? 0]
    );
  }

  for (const row of queryRows('SELECT * FROM verifications_old')) {
    runSql(
      `INSERT INTO verifications (wifi_id, user_id, status, created_at) VALUES (?, ?, ?, ?)`,
      [wifiIdMap.get(row.wifi_id) ?? row.wifi_id, userIdMap.get(row.user_id) ?? row.user_id, row.status, row.created_at]
    );
  }

  for (const row of queryRows('SELECT * FROM votes_old')) {
    runSql(
      `INSERT INTO votes (wifi_id, user_id, type, download_mbps, upload_mbps, ping_ms, reason, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [wifiIdMap.get(row.wifi_id) ?? row.wifi_id, userIdMap.get(row.user_id) ?? row.user_id, row.type, row.download_mbps, row.upload_mbps, row.ping_ms, row.reason, row.comment, row.created_at]
    );
  }

  for (const row of queryRows('SELECT * FROM wifi_history_old')) {
    runSql(
      `INSERT INTO wifi_history (wifi_id, user_id, action, snapshot, created_at, anonymous) VALUES (?, ?, ?, ?, ?, ?)`,
      [wifiIdMap.get(row.wifi_id) ?? row.wifi_id, userIdMap.get(row.user_id) ?? row.user_id, row.action, row.snapshot, row.created_at, row.anonymous ?? 0]
    );
  }

  for (const row of queryRows('SELECT * FROM comments_old')) {
    runSql(
      `INSERT INTO comments (wifi_id, user_id, content, created_at) VALUES (?, ?, ?, ?)`,
      [wifiIdMap.get(row.wifi_id) ?? row.wifi_id, userIdMap.get(row.user_id) ?? row.user_id, row.content, row.created_at]
    );
  }

  for (const row of queryRows('SELECT * FROM password_resets_old')) {
    runSql(
      `INSERT INTO password_resets (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      [userIdMap.get(row.user_id) ?? row.user_id, row.token, row.expires_at, row.created_at]
    );
  }

  ['users_old', 'wifi_points_old', 'verifications_old', 'votes_old', 'wifi_history_old', 'comments_old', 'password_resets_old'].forEach(table => {
    if (tableExists(table)) _db.run(`DROP TABLE ${table}`);
  });
  _db.run('PRAGMA foreign_keys = ON');
}

// Mimic better-sqlite3's prepare().get/all/run API
function prepare(sql) {
  return {
    get(...params) {
      const stmt = _db.prepare(sql);
      stmt.bind(params.flat());
      const row = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return row;
    },
    all(...params) {
      const stmt = _db.prepare(sql);
      stmt.bind(params.flat());
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    run(...params) {
      const stmt = _db.prepare(sql);
      stmt.bind(params.flat());
      stmt.step();
      stmt.free();
      const lastInsertRowid = _db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? null;
      save();
      return { lastInsertRowid };
    }
  };
}

function exec(sql) {
  _db.run(sql);
  save();
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    points INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    role TEXT DEFAULT 'member',
    banned INTEGER DEFAULT 0,
    session_version INTEGER DEFAULT 0,
    email_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS wifi_points (
    id TEXT PRIMARY KEY,
    ssid TEXT NOT NULL,
    password TEXT,
    encryption TEXT NOT NULL DEFAULT 'open',
    captive_portal INTEGER DEFAULT 0,
    gateway TEXT,
    dhcp_range TEXT,
    download_mbps REAL,
    upload_mbps REAL,
    ping_ms REAL,
    isp TEXT,
    place_type TEXT,
    hours TEXT,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    author_id TEXT,
    confidence_score REAL DEFAULT 50,
    last_verified DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wifi_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('works','broken')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wifi_id) REFERENCES wifi_points(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wifi_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('up','down')),
    download_mbps REAL,
    upload_mbps REAL,
    ping_ms REAL,
    reason TEXT,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wifi_id) REFERENCES wifi_points(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS wifi_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wifi_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wifi_id) REFERENCES wifi_points(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wifi_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wifi_id) REFERENCES wifi_points(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS email_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    last_sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// db is initialized async, export a promise and a proxy
let _ready;
const db = {
  prepare,
  exec,
  get _db() { return _db; },
  ready: null,
};

_ready = initSqlJs().then(SQL => {
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }

  const needsMigration = tableExists('users') && tableExists('wifi_points') && getColumnInfo('users').find(row => row[1] === 'id')?.[2]?.toUpperCase() === 'INTEGER';
  if (needsMigration) {
    migrateToUuidSchema();
  } else {
    createTables();
  }

  try { _db.run(`ALTER TABLE wifi_points ADD COLUMN anonymous INTEGER DEFAULT 0`); } catch (e) {}
  try { _db.run(`ALTER TABLE wifi_history ADD COLUMN anonymous INTEGER DEFAULT 0`); } catch (e) {}
  save();
  db.ready = Promise.resolve();
  return db;
});

db.ready = _ready;

module.exports = db;
