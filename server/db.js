const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(path.join(config.dataDir, 'multiwall.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    provider      TEXT NOT NULL DEFAULT 'local' CHECK (provider IN ('local','entra')),
    external_id   TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login    TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_external ON users(provider, external_id)
    WHERE external_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    category   TEXT NOT NULL DEFAULT '',
    logo_url   TEXT NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    proxy      INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    user_id      INTEGER,
    username     TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    provider     TEXT NOT NULL DEFAULT 'local',
    outcome      TEXT NOT NULL CHECK (outcome IN ('success','failed','signout')),
    detail       TEXT NOT NULL DEFAULT '',
    ip           TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS login_events_created ON login_events(created_at);

  CREATE TABLE IF NOT EXISTS layouts (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- password hashing (scrypt, no native deps) -----------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---- first-run bootstrap ----------------------------------------------------
function bootstrap() {
  const admins = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND provider = 'local'"
  ).get().n;

  if (admins === 0) {
    const generated = !config.adminPassword;
    const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
    db.prepare(
      "INSERT INTO users (username, display_name, password_hash, role, provider) VALUES (?, 'Administrator', ?, 'admin', 'local')"
    ).run(config.adminUsername, hashPassword(password));
    console.log('==============================================================');
    console.log(` Created admin account: ${config.adminUsername}`);
    if (generated) {
      console.log(` Generated password:    ${password}`);
      console.log(' (set ADMIN_PASSWORD to choose your own; change it after login)');
    } else {
      console.log(' Password taken from ADMIN_PASSWORD');
    }
    console.log('==============================================================');
  }

  if (config.seedDemoChannels && db.prepare('SELECT COUNT(*) AS n FROM channels').get().n === 0) {
    const ins = db.prepare(
      'INSERT INTO channels (name, url, category, sort_order) VALUES (?, ?, ?, ?)'
    );
    [
      ['Demo: Big Buck Bunny', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 'Demo'],
      ['Demo: Apple BipBop', 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8', 'Demo'],
      ['Demo: Tears of Steel', 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', 'Demo'],
    ].forEach((c, i) => ins.run(c[0], c[1], c[2], i));
  }
}
bootstrap();

module.exports = { db, hashPassword, verifyPassword };
