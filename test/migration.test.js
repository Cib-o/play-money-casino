import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, CREDIT, DEFAULT_SETTINGS } from '../src/db.js';

// The v0 schema, written out by hand rather than imported from src/db.js.
// The point of a migration test is to describe the world being upgraded
// *from*, and the code under test no longer knows what that world looked
// like — reusing its SCHEMA would let a future edit quietly redefine the
// starting point and still pass. This is a fixture, so it is frozen.
//
// Columns and types are identical in both generations; only the meaning
// of the integers changed, from whole credits to hundredths.
const V0_SCHEMA = `
CREATE TABLE users (
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
CREATE TABLE balance_adjustments (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  admin_id   TEXT NOT NULL REFERENCES users(id),
  "before"   INTEGER NOT NULL,
  "after"    INTEGER NOT NULL,
  delta      INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE rounds (
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
CREATE TABLE seeds (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  server_seed TEXT NOT NULL,
  hash        TEXT NOT NULL,
  client_seed TEXT NOT NULL,
  nonce       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE blackjack_states (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const NOW = '2026-01-01T00:00:00.000Z';

// A roulette slip as the old code wrote it: whole credits, inside the
// outcome blob rather than in a column. The history page reads these
// back to redraw the bets, so they have to move with everything else.
// Shapes below are copied from rounds written by the pre-rescale build,
// down to the null selection an outside bet carries.
const ROULETTE_V0 = {
  number: 17,
  bets: [
    { type: 'straight', selection: 17, amount: 5, win: false, payout: 0 },
    { type: 'red', selection: null, amount: 10, win: true, payout: 20 },
  ],
};

// Dice and slots keep a multiplier, a roll, an RTP and reel stops. Every
// one of them is unitless, and a rescale that caught `mult` would turn a
// 1.92x game into a 192x one.
const DICE_V0 = { rtp: 0.96, target: 50, direction: 'under', roll: 5.72, win: true, mult: 1.92 };
const SLOTS_V0 = {
  rtp: 0.96, machine: 'meadow', kind: 'lines',
  mult: 4.06350162371675, stops: [14, 27, 27, 33, 10],
};

/** A v0 database on disk, with one of everything the rescale touches. */
function seedV0(file) {
  const db = new Database(file);
  db.exec(V0_SCHEMA);
  assert.equal(db.pragma('user_version', { simple: true }), 0, 'a fresh file starts at 0');

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
     VALUES (?, ?, ?, 'hash', ?, ?, 'ka', 1, ?, NULL)`,
  ).run('u-admin', 'boss', 'Boss', 'admin', 0, NOW);
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
     VALUES (?, ?, ?, 'hash', ?, ?, 'ka', 1, ?, 'u-admin')`,
  ).run('u-gia', 'gia', 'Gia', 'player', 1234, NOW);

  db.prepare(
    `INSERT INTO balance_adjustments (id, user_id, admin_id, "before", "after", delta, note, created_at)
     VALUES (?, 'u-gia', 'u-admin', ?, ?, ?, ?, ?)`,
  ).run('a-1', 0, 1000, 1000, 'opening balance', NOW);
  db.prepare(
    `INSERT INTO balance_adjustments (id, user_id, admin_id, "before", "after", delta, note, created_at)
     VALUES (?, 'u-gia', 'u-admin', ?, ?, ?, ?, ?)`,
  ).run('a-2', 1000, 750, -250, 'clawback', NOW);

  const round = db.prepare(
    `INSERT INTO rounds (id, user_id, game, bet, payout, net, outcome_json,
                         server_seed_hash, server_seed, client_seed, nonce, created_at)
     VALUES (?, 'u-gia', ?, ?, ?, ?, ?, 'seed-hash', 'seed', 'client', ?, ?)`,
  );
  round.run('r-roulette', 'roulette', 15, 20, 5, JSON.stringify(ROULETTE_V0), 0, NOW);
  round.run('r-dice', 'dice', 25, 48, 23, JSON.stringify(DICE_V0), 1, NOW);
  round.run('r-slots', 'slots', 5, 20, 15, JSON.stringify(SLOTS_V0), 2, NOW);

  // Settings as an operator had left them: a floor of 1 credit, a
  // ceiling of 500, and new players starting on 1000.
  const setting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries({
    rtp: '0.96', min_bet: '1', max_bet: '500', default_balance: '1000',
    default_locale: 'ka', site_name: 'Lucky Lion', blackjack_max_bots: '4',
    game_slots: '1', game_roulette: '1', game_dice: '1', game_blackjack: '1',
  })) setting.run(key, value);

  db.close();
}

/**
 * A scratch directory holding one database file, cleaned up when the
 * test ends. Opening goes through here so the teardown can close every
 * handle before it deletes anything: Windows refuses to unlink a file
 * that is still open, and WAL mode leaves two more beside it.
 */
function sandbox(t, name = 'casino.db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmc-mig-'));
  const file = path.join(dir, name);
  const open = [];
  t.after(() => {
    for (const db of open) if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    file,
    openDb: () => {
      const db = openDb(file);
      open.push(db);
      return db;
    },
  };
}

/** Everything the rescale is supposed to have touched, in one object. */
function readMoney(db) {
  return {
    balance: db.prepare("SELECT balance FROM users WHERE id = 'u-gia'").get().balance,
    adminBalance: db.prepare("SELECT balance FROM users WHERE id = 'u-admin'").get().balance,
    adjustments: db
      .prepare('SELECT id, "before", "after", delta FROM balance_adjustments ORDER BY id')
      .all(),
    rounds: db.prepare('SELECT id, bet, payout, net FROM rounds ORDER BY id').all(),
    settings: Object.fromEntries(
      db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]),
    ),
  };
}

// The settings table mixes money with things that only look like it. A
// rescale that reached one key too far would read 0.96 as an integer,
// get 0, and hand the floor an RTP of zero — a house that keeps every
// stake. These are the keys that must come through untouched.
const UNITLESS_SETTINGS = {
  rtp: '0.96',
  default_locale: 'ka',
  site_name: 'Lucky Lion',
  blackjack_max_bots: '4',
  game_slots: '1',
  game_roulette: '1',
  game_dice: '1',
  game_blackjack: '1',
};

test('an existing database is rescaled to hundredths exactly once', (t) => {
  const box = sandbox(t);
  seedV0(box.file);

  const db = box.openDb();
  assert.equal(db.pragma('user_version', { simple: true }), 1, 'the file is stamped as converted');

  const money = readMoney(db);
  assert.equal(money.balance, 1234 * CREDIT);
  assert.equal(money.adminBalance, 0, 'nothing times a hundred is still nothing');
  assert.deepEqual(money.adjustments, [
    { id: 'a-1', before: 0, after: 1000 * CREDIT, delta: 1000 * CREDIT },
    { id: 'a-2', before: 1000 * CREDIT, after: 750 * CREDIT, delta: -250 * CREDIT },
  ], 'a clawback stays negative and the running balance still lines up');
  assert.deepEqual(money.rounds, [
    { id: 'r-dice', bet: 25 * CREDIT, payout: 48 * CREDIT, net: 23 * CREDIT },
    { id: 'r-roulette', bet: 15 * CREDIT, payout: 20 * CREDIT, net: 5 * CREDIT },
    { id: 'r-slots', bet: 5 * CREDIT, payout: 20 * CREDIT, net: 15 * CREDIT },
  ]);

  // The operator's floor of 1 credit must still be 1 credit, not the
  // hundredth of one that a bare copy of the old string would now mean.
  assert.deepEqual(money.settings, {
    min_bet: String(1 * CREDIT),
    max_bet: String(500 * CREDIT),
    default_balance: String(1000 * CREDIT),
    ...UNITLESS_SETTINGS,
  });

  // The stake and payout on each placed bet live inside the blob, so the
  // slip on the history page has to have moved with the columns.
  const roulette = JSON.parse(
    db.prepare("SELECT outcome_json FROM rounds WHERE id = 'r-roulette'").get().outcome_json,
  );
  assert.equal(roulette.number, 17, 'the pocket is a pocket, not an amount');
  assert.deepEqual(roulette.bets, [
    { type: 'straight', selection: 17, amount: 5 * CREDIT, win: false, payout: 0 },
    { type: 'red', selection: null, amount: 10 * CREDIT, win: true, payout: 20 * CREDIT },
  ]);
  assert.equal(
    roulette.bets.reduce((sum, b) => sum + b.amount, 0),
    db.prepare("SELECT bet FROM rounds WHERE id = 'r-roulette'").get().bet,
    'the slip must still add up to the stake in the column',
  );

  // Everything else stores multipliers, rolls and reel stops: unitless,
  // and a rescale that reached them would turn 1.92x into 192x. Compared
  // as text, so a blob that was parsed and re-serialised — reordering
  // keys or rounding 4.06350162371675 on the way through — fails here
  // too. The safest migration of a row it has no business touching is
  // not to write it at all.
  for (const [id, original] of [['r-dice', DICE_V0], ['r-slots', SLOTS_V0]]) {
    assert.equal(
      db.prepare('SELECT outcome_json FROM rounds WHERE id = ?').get(id).outcome_json,
      JSON.stringify(original),
      `${id}: a non-money outcome must come through byte for byte`,
    );
  }
});

test('reopening a converted database does not rescale it again', (t) => {
  const box = sandbox(t);
  seedV0(box.file);

  const first = box.openDb();
  const after = readMoney(first);
  first.close();

  // Three more opens, because the guard being a stored version rather
  // than a heuristic is the whole reason this is safe to ship: the
  // migration has no way to tell a converted floor from one where
  // everybody bets in round hundreds.
  for (let i = 0; i < 3; i++) {
    const db = box.openDb();
    assert.deepEqual(readMoney(db), after, `open ${i + 2} moved the money`);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    db.close();
  }
});

test('a database created today is already in hundredths and is not converted', (t) => {
  const db = sandbox(t, 'fresh.db').openDb();
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  // The version is stamped before the defaults are inserted, so these
  // are the shipped values untouched. Were the order the other way
  // round, a brand new floor would open with a 100-credit minimum bet.
  const settings = Object.fromEntries(
    db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]),
  );
  for (const key of ['min_bet', 'max_bet', 'default_balance']) {
    assert.equal(settings[key], DEFAULT_SETTINGS[key], `${key} was scaled a second time`);
  }
});
