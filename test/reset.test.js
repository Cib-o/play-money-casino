import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb, nowISO, getSettings, setSetting } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { RESET_TOKEN } from '../src/routes/admin.js';

const SECRET = 'test-session-secret-0123456789abcdef0123456789';

function makeApp() {
  const db = openDb(':memory:');
  const app = buildApp({ db, config: { sessionSecret: SECRET, production: false }, logger: false });
  return { db, app };
}

function addAdmin(db, username) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
     VALUES (?, ?, ?, ?, 'admin', 0, 'ka', 1, ?, NULL)`,
  ).run(id, username, username, hashPassword('password-123'), nowISO());
  return id;
}

async function login(app, username) {
  const res = await app.inject({
    method: 'POST', url: '/api/login', payload: { username, password: 'password-123' },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { sid: res.cookies.find((c) => c.name === 'sid').value };
}

const get = async (app, url, cookies) => {
  const res = await app.inject({ method: 'GET', url, cookies });
  assert.equal(res.statusCode, 200, `${url} -> ${res.body}`);
  return JSON.parse(res.body);
};

const post = async (app, url, cookies, payload) => {
  const res = await app.inject({ method: 'POST', url, cookies, payload });
  assert.ok(res.statusCode < 300, `${url} -> ${res.statusCode} ${res.body}`);
  return JSON.parse(res.body);
};

// Through the admin endpoint, because that is the only way a player is
// really made: it books the opening balance as an adjustment. A row
// poked straight into users has credits behind no record, which is the
// very thing the reconciliation below is watching for.
async function createPlayer(app, admin, username, balance) {
  const res = await app.inject({
    method: 'POST', url: '/api/admin/players', cookies: admin,
    payload: { username, balance, password: 'password-123' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).user.id;
}

// Every table play writes to. If a game ever starts keeping its state
// somewhere else, this list is where that has to be noticed — a table
// missing from here is a table the reset would leave behind.
const counts = (db) => ({
  rounds: db.prepare('SELECT COUNT(*) AS c FROM rounds').get().c,
  adjustments: db.prepare('SELECT COUNT(*) AS c FROM balance_adjustments').get().c,
  hands: db.prepare('SELECT COUNT(*) AS c FROM blackjack_states').get().c,
  seeds: db.prepare('SELECT COUNT(*) AS c FROM seeds').get().c,
});

const money = (db) =>
  db.prepare('SELECT COUNT(*) AS users, COALESCE(SUM(balance), 0) AS total, MAX(balance) AS top FROM users').get();

test('a reset clears everything play produced and leaves the accounts standing', async () => {
  const { db, app } = makeApp();
  addAdmin(db, 'boss');
  const admin = await login(app, 'boss');

  await createPlayer(app, admin, 'gia', 50000);
  const ninoId = await createPlayer(app, admin, 'nino', 30000);
  const gia = await login(app, 'gia');

  // Real play, through the same routes a player uses, so the rows being
  // cleared are the rows the application actually writes.
  for (let i = 0; i < 12; i++) {
    await post(app, '/api/game/dice/roll', gia, { bet: 100, target: 50, direction: 'under' });
  }
  for (let i = 0; i < 8; i++) await post(app, '/api/game/slots/spin', gia, { bet: 100 });
  await post(app, '/api/game/roulette/spin', gia, { bets: [{ type: 'red', amount: 200 }] });
  // A hand deliberately left open. Dealt a natural the round settles on
  // the spot and saves nothing, so this deals until one is still live.
  for (let i = 0; i < 12 && counts(db).hands === 0; i++) {
    await post(app, '/api/game/blackjack/deal', gia, { bet: 100 });
  }
  // And an admin edit, so the audit log has something in it beyond the
  // two opening balances.
  await post(app, `/api/admin/players/${ninoId}/balance`, admin, { delta: -500, note: 'clawback' });

  const before = counts(db);
  assert.ok(before.rounds > 20, 'the floor must really have been played on');
  assert.equal(before.adjustments, 3, 'two opening balances and the clawback');
  assert.ok(before.seeds > 0, 'play issues a seed pair');
  assert.ok(before.hands > 0, 'a hand must be open for the wipe to have one to clear');
  const settingsBefore = getSettings(db);

  const res = await post(app, '/api/admin/reset', admin, { confirm: RESET_TOKEN });
  assert.deepEqual(
    res.cleared,
    { ...before, balances: 2 },
    'the report must name what was actually there — both players held credits, the admin never did',
  );

  // Every table play wrote to is empty…
  assert.deepEqual(counts(db), { rounds: 0, adjustments: 0, hands: 0, seeds: 0 });
  // …and every balance is zero, the admin's included.
  assert.deepEqual(money(db), { users: 3, total: 0, top: 0 });

  // The people are still here, and unchanged.
  const users = db
    .prepare('SELECT username, display_name, locale, is_active, role FROM users ORDER BY username')
    .all();
  assert.deepEqual(users, [
    { username: 'boss', display_name: 'boss', locale: 'ka', is_active: 1, role: 'admin' },
    { username: 'gia', display_name: 'gia', locale: 'ka', is_active: 1, role: 'player' },
    { username: 'nino', display_name: 'nino', locale: 'ka', is_active: 1, role: 'player' },
  ]);
  // Still here is not the same as still able to get in: the password
  // hashes have to have survived the wipe too, or every account is a
  // locked door with the right name on it.
  for (const username of ['boss', 'gia', 'nino']) await login(app, username);

  // The house is configured how the operator left it. Clearing the floor
  // is not a request to have the limits reverted underneath them.
  assert.deepEqual(getSettings(db), settingsBefore);

  // And the books close on nothing: no grants, no play, no credits.
  const floor = await get(app, '/api/admin/circulation', admin);
  assert.equal(floor.reconciled, true);
  assert.equal(floor.drift, 0);
  assert.equal(floor.balance, 0);
  assert.equal(floor.granted, 0);
  assert.equal(floor.rounds, 0);
  assert.equal(floor.players, 2, 'the players are counted, they were simply not deleted');
  assert.deepEqual(floor.games, []);
  assert.equal(floor.rtp, null, 'there is no return to report from no rounds');

  await app.close();
});

test('a reset needs the word typed exactly, and changes nothing without it', async () => {
  const { db, app } = makeApp();
  addAdmin(db, 'boss');
  const admin = await login(app, 'boss');
  const giaId = await createPlayer(app, admin, 'gia', 5000);
  const gia = await login(app, 'gia');
  await post(app, '/api/game/dice/roll', gia, { bet: 100, target: 50, direction: 'under' });

  const before = counts(db);
  const balance = () => db.prepare('SELECT balance FROM users WHERE id = ?').get(giaId).balance;
  const kept = balance();

  const refused = [
    {},
    { confirm: 'reset' },
    { confirm: 'RESET ' },
    { confirm: '' },
    { confirm: RESET_TOKEN, and_also: 'everything' },
  ];
  for (const payload of refused) {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/reset', cookies: admin, payload,
    });
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload)} -> ${res.statusCode} ${res.body}`);
    assert.equal(JSON.parse(res.body).error, 'err_validation');
  }

  assert.deepEqual(counts(db), before, 'a refused reset must not have touched a single row');
  assert.equal(balance(), kept);
  await app.close();
});

// The one that is easy to get wrong. A seat mid-round holds the id of a
// rounds row the wipe has just deleted, and the phase timers to finish
// playing it are already scheduled. Left alone they would fire after the
// reset, pay a hand out of a round that no longer exists, and leave the
// floor holding credits with nothing behind them.
test('a hand in flight is abandoned rather than settled when the floor is reset', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { db, app } = makeApp();
  setSetting(db, 'blackjack_max_bots', '0'); // an empty room, so the seat is ours
  addAdmin(db, 'boss');
  const admin = await login(app, 'boss');
  const playerId = await createPlayer(app, admin, 'gia', 50000);
  const user = { id: playerId, username: 'gia' };

  // The app's own table, because that is the one the endpoint resets.
  const table = app.blackjackTable;
  table.start();
  t.after(() => table.stop());

  const balanceOf = () => db.prepare('SELECT balance FROM users WHERE id = ?').get(playerId).balance;
  // A tick does not run timers scheduled during it, and each phase
  // schedules the next from inside the last, so the clock is walked
  // forward in short steps rather than jumped by one big number.
  const tick = (seconds) => {
    for (let i = 0; i < seconds; i++) t.mock.timers.tick(1000);
  };

  table.sit(user, 0);
  table.bet(user, 10000);
  for (let i = 0; i < 40 && table.snapshot(user).seats[0].hand.length === 0; i++) tick(1);
  assert.equal(table.snapshot(user).seats[0].hand.length, 2, 'a hand must be on the felt');
  assert.equal(balanceOf(), 40000, 'the stake has left the balance');
  assert.equal(counts(db).rounds, 1, 'and the round it went into is on the books');
  assert.equal(
    (await get(app, '/api/admin/circulation', admin)).in_flight.staked,
    10000,
    'the dashboard can see it is still in play',
  );

  await post(app, '/api/admin/reset', admin, { confirm: RESET_TOKEN });

  // The felt is clear and the row is gone in the same breath.
  const after = table.snapshot(user);
  assert.equal(after.your_seat, -1, 'the player has been stood up');
  assert.equal(after.seats.filter((s) => s.occupied).length, 0, 'every seat is empty');
  assert.deepEqual(after.dealer.cards, [], 'and the dealer is holding nothing');
  assert.equal(counts(db).rounds, 0);
  assert.equal(balanceOf(), 0);

  // Now run the clock well past every phase the abandoned round had left
  // to play — deal, act, dealer, payout, and several rounds after it.
  tick(300);

  assert.equal(balanceOf(), 0, 'the abandoned hand paid nobody');
  assert.deepEqual(counts(db), { rounds: 0, adjustments: 0, hands: 0, seeds: 0 },
    'and an empty table writes no rounds of its own');
  const floor = await get(app, '/api/admin/circulation', admin);
  assert.equal(floor.reconciled, true);
  assert.equal(floor.in_flight.rounds, 0);
  assert.equal(floor.balance, 0);

  await app.close();
});
