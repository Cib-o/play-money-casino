import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Default settings written once with INSERT OR IGNORE, so an operator's
 * later edits always survive a restart. All values are stored as text;
 * readSettings() is the typed view the rest of the app uses.
 */
export const DEFAULT_SETTINGS = {
  rtp: '0.96',
  min_bet: '1',
  max_bet: '500',
  default_balance: '1000',
  default_locale: 'ka',
  site_name: 'Lucky Lion',
  game_slots: '1',
  game_roulette: '1',
};

// "before"/"after" are quoted because BEFORE and AFTER are SQL keywords.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','player')),
  balance       INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  locale        TEXT NOT NULL DEFAULT 'ka' CHECK (locale IN ('ka','en')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS balance_adjustments (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  admin_id   TEXT NOT NULL REFERENCES users(id),
  "before"   INTEGER NOT NULL,
  "after"    INTEGER NOT NULL,
  delta      INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  game             TEXT NOT NULL,
  bet              INTEGER NOT NULL,
  payout           INTEGER NOT NULL,
  net              INTEGER NOT NULL,
  outcome_json     TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  server_seed      TEXT,
  client_seed      TEXT NOT NULL,
  nonce            INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seeds (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  server_seed TEXT NOT NULL,
  hash        TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rounds_user_time ON rounds (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rounds_time ON rounds (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adjustments_user_time ON balance_adjustments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_adjustments_time ON balance_adjustments (created_at DESC);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(SCHEMA);
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value);
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

export function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

/**
 * Typed view of the settings table. Per-game toggles are any key of the
 * form game_<name>, so adding a game never needs a schema change.
 */
export function readSettings(db) {
  const raw = getSettings(db);
  const games = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('game_')) games[key.slice(5)] = value === '1';
  }
  return {
    rtp: Number(raw.rtp),
    minBet: Number(raw.min_bet),
    maxBet: Number(raw.max_bet),
    defaultBalance: Number(raw.default_balance),
    defaultLocale: raw.default_locale,
    siteName: raw.site_name,
    games,
  };
}

export function nowISO() {
  return new Date().toISOString();
}
