import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Every credit amount in this application — in the database, over the
 * API, and in every calculation on either side of it — is an integer
 * count of hundredths of a credit. One credit is 100 of them, and the
 * smallest amount the system can express is 1, which is 0.01 credits.
 *
 * Money is never a float here. A stake of 0.10 split across 20 paylines
 * is 10 units divided twenty ways, and the halfpennies that leaves are
 * decided by one explicit rounding rather than by whatever the binary
 * expansion of 0.005 happens to do. The browser divides by this only to
 * print a number and multiplies by it only to send one; nothing in
 * between ever sees a decimal point.
 *
 * The frontend carries its own copy in public/js/i18n.js, since the two
 * halves share no module. A test pins them equal.
 */
export const CREDIT = 100;

/**
 * Default settings written once with INSERT OR IGNORE, so an operator's
 * later edits always survive a restart. All values are stored as text;
 * readSettings() is the typed view the rest of the app uses.
 *
 * The bet and balance figures are in the unit above: 1 is 0.01 credits,
 * 50000 is 500, 100000 is 1000.
 */
export const DEFAULT_SETTINGS = {
  rtp: '0.96',
  min_bet: '1',
  max_bet: '50000',
  default_balance: '100000',
  default_locale: 'ka',
  site_name: 'Lucky Lion',
  blackjack_max_bots: '4',
  game_slots: '1',
  game_roulette: '1',
  game_dice: '1',
  game_blackjack: '1',
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

CREATE TABLE IF NOT EXISTS blackjack_states (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

// Schema generations, tracked in PRAGMA user_version:
//   0  credits counted in whole units
//   1  credits counted in hundredths (see CREDIT)
const SCHEMA_VERSION = 1;

/**
 * Credits used to be whole numbers. Every amount already on disk is
 * therefore a hundredth of what it should now read, and multiplying is
 * the whole of the change — no column types move, and the arithmetic is
 * exact in both directions because these are integers.
 *
 * Only roulette wrote amounts inside outcome_json (each placed bet keeps
 * its own stake and payout, so the history page can show the slip). The
 * other games store multipliers and card faces, which are unitless and
 * must be left alone.
 *
 * This runs once. It is guarded by the version above rather than by
 * looking for suspiciously small numbers, because a floor where everyone
 * happens to bet 1 is indistinguishable from one that has already been
 * converted.
 */
function toHundredths(db) {
  db.exec(`
    UPDATE users SET balance = balance * ${CREDIT};
    UPDATE rounds SET bet = bet * ${CREDIT}, payout = payout * ${CREDIT}, net = net * ${CREDIT};
    UPDATE balance_adjustments
       SET "before" = "before" * ${CREDIT}, "after" = "after" * ${CREDIT}, delta = delta * ${CREDIT};
    UPDATE settings SET value = CAST(CAST(value AS INTEGER) * ${CREDIT} AS TEXT)
     WHERE key IN ('min_bet', 'max_bet', 'default_balance');
  `);

  const update = db.prepare('UPDATE rounds SET outcome_json = ? WHERE id = ?');
  for (const row of db.prepare("SELECT id, outcome_json FROM rounds WHERE game = 'roulette'").all()) {
    const outcome = JSON.parse(row.outcome_json);
    if (!Array.isArray(outcome.bets)) continue;
    for (const bet of outcome.bets) {
      bet.amount *= CREDIT;
      bet.payout *= CREDIT;
    }
    update.run(JSON.stringify(outcome), row.id);
  }
}

export function migrate(db) {
  db.exec(SCHEMA);

  // Before the defaults are written, so a fresh database — where every
  // table is empty and the rescale is a no-op — takes its defaults in
  // the current unit rather than in one it then converts again.
  const version = db.pragma('user_version', { simple: true });
  if (version < SCHEMA_VERSION) {
    db.transaction(() => {
      if (version < 1) toHundredths(db);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }

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
    maxBots: raw.blackjack_max_bots === undefined ? 4 : Number(raw.blackjack_max_bots),
    games,
  };
}

export function nowISO() {
  return new Date().toISOString();
}
