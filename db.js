const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.resolve('./kiviomap.db');

let _db = null;

function getDb() { return _db; }

function save() {
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    author_id INTEGER,
    confidence_score REAL DEFAULT 50,
    last_verified DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wifi_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('works','broken')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wifi_id) REFERENCES wifi_points(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wifi_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
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
    wifi_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wifi_id) REFERENCES wifi_points(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wifi_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wifi_id) REFERENCES wifi_points(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
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
  _db.run(SCHEMA);
  try { _db.run(`ALTER TABLE wifi_points ADD COLUMN anonymous INTEGER DEFAULT 0`); } catch(e) {}
  try { _db.run(`ALTER TABLE wifi_history ADD COLUMN anonymous INTEGER DEFAULT 0`); } catch(e) {}
  save();
  db.ready = Promise.resolve();
  return db;
});

db.ready = _ready;

module.exports = db;
