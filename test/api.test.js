import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { openDb, nowISO, CREDIT } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { MACHINE_IDS } from '../src/games/slots.js';
import { LINE_MACHINES } from '../src/games/slot-lines.js';
import { FLOOR_IDS, FLOOR_DEFAULT } from '../src/games/slot-floor.js';

const SECRET = 'test-session-secret-0123456789abcdef0123456789';

function makeApp() {
  const db = openDb(':memory:');
  const app = buildApp({ db, config: { sessionSecret: SECRET, production: false }, logger: false });
  return { db, app };
}

function addUser(db, { username, password = 'password-123', role = 'player', balance = 0, active = 1 }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'ka', ?, ?, NULL)`,
  ).run(id, username, username, hashPassword(password), role, balance, active, nowISO());
  return id;
}

async function login(app, username, password = 'password-123') {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, res.body);
  const sid = res.cookies.find((c) => c.name === 'sid');
  assert.ok(sid, 'session cookie set');
  return { sid: sid.value };
}

test('anonymous requests get 401 on every game route', async () => {
  const { app } = makeApp();
  const routes = [
    ['GET', '/api/me'],
    ['GET', '/api/seed'],
    ['GET', '/api/history'],
    ['GET', '/api/rounds/some-id'],
    ['POST', '/api/seed/client', { client_seed: 'abc' }],
    ['POST', '/api/seed/rotate'],
    ['GET', '/api/game/slots/machines'],
    ['POST', '/api/game/slots/spin', { bet: 1 }],
    ['POST', '/api/profile', { locale: 'en' }],
    ['POST', '/api/password', { current: 'x', next: 'longenough' }],
  ];
  for (const [method, url, payload] of routes) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, 401, `${method} ${url} -> ${res.statusCode}`);
    assert.equal(JSON.parse(res.body).error, 'err_unauthorized');
  }
  await app.close();
});

test('player sessions get 403 on every admin route', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'player1', balance: 100 });
  const cookies = await login(app, 'player1');
  const routes = [
    ['GET', '/api/admin/players'],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/rounds'],
    ['GET', '/api/admin/settings'],
    ['GET', '/api/admin/players/x/adjustments'],
    ['GET', '/api/admin/players/x/analytics'],
    ['GET', '/api/admin/circulation'],
    ['POST', '/api/admin/players', { username: 'zzz' }],
    ['POST', '/api/admin/players/x/balance', { set: 10 }],
    ['POST', '/api/admin/players/x/reset-password'],
    ['POST', '/api/admin/players/x/active', { is_active: false }],
    ['POST', '/api/admin/settings', { rtp: 0.95 }],
    ['POST', '/api/admin/reset', { confirm: 'RESET' }],
  ];
  for (const [method, url, payload] of routes) {
    const res = await app.inject({ method, url, payload, cookies });
    assert.equal(res.statusCode, 403, `${method} ${url} -> ${res.statusCode}`);
    assert.equal(JSON.parse(res.body).error, 'err_forbidden');
  }
  await app.close();
});

test('login: same error for wrong password and unknown user; disabled accounts rejected', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'known' });
  addUser(db, { username: 'sleeper', active: 0 });

  const wrongPass = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'known', password: 'nope-nope' },
  });
  const unknownUser = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'ghost', password: 'nope-nope' },
  });
  assert.equal(wrongPass.statusCode, 401);
  assert.equal(unknownUser.statusCode, 401);
  assert.deepEqual(JSON.parse(wrongPass.body), JSON.parse(unknownUser.body));

  const disabled = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'sleeper', password: 'password-123' },
  });
  assert.equal(disabled.statusCode, 403);
  assert.equal(JSON.parse(disabled.body).error, 'err_account_disabled');
  await app.close();
});

test('login is rate-limited per IP: 10 attempts, then 429', async () => {
  const { app } = makeApp();
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/login', payload: { username: 'ghost', password: 'x'.repeat(8) },
    });
    assert.equal(res.statusCode, 401, `attempt ${i + 1}`);
  }
  const blocked = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'ghost', password: 'x'.repeat(8) },
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(JSON.parse(blocked.body).error, 'err_rate_limited');
  await app.close();
});

test('admin creates a player; the returned password works; duplicates are rejected', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const cookies = await login(app, 'boss');

  const created = await app.inject({
    method: 'POST', url: '/api/admin/players', cookies,
    payload: { username: 'NewGuy', display_name: 'ახალი მოთამაშე' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { user, password } = JSON.parse(created.body);
  assert.equal(user.username, 'newguy'); // stored lowercase
  assert.equal(user.balance, 1000 * CREDIT); // default_balance setting
  assert.match(password, /^[a-z]+-[a-z]+-[a-z]+-\d\d$/);

  // Starting balance left an audit row.
  const adj = db.prepare('SELECT * FROM balance_adjustments WHERE user_id = ?').all(user.id);
  assert.equal(adj.length, 1);
  assert.equal(adj[0].before, 0);
  assert.equal(adj[0].after, 1000 * CREDIT);

  await login(app, 'newguy', password);

  const dupe = await app.inject({
    method: 'POST', url: '/api/admin/players', cookies, payload: { username: 'newguy' },
  });
  assert.equal(dupe.statusCode, 409);
  assert.equal(JSON.parse(dupe.body).error, 'err_username_taken');
  await app.close();
});

test('balance edits: set and delta both audit; negative results are rejected', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const playerId = addUser(db, { username: 'p1', balance: 100 });
  const cookies = await login(app, 'boss');

  const set = await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/balance`, cookies,
    payload: { set: 500, note: 'top up' },
  });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(JSON.parse(set.body).balance, 500);

  const delta = await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/balance`, cookies,
    payload: { delta: -200 },
  });
  assert.equal(JSON.parse(delta.body).balance, 300);

  const negative = await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/balance`, cookies,
    payload: { delta: -400 },
  });
  assert.equal(negative.statusCode, 400);
  assert.equal(JSON.parse(negative.body).error, 'err_negative_balance');
  assert.equal(db.prepare('SELECT balance FROM users WHERE id = ?').get(playerId).balance, 300);

  // Exactly one of set/delta, and no unknown fields.
  const both = await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/balance`, cookies,
    payload: { set: 10, delta: 5 },
  });
  assert.equal(both.statusCode, 400);
  const neither = await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/balance`, cookies, payload: {},
  });
  assert.equal(neither.statusCode, 400);
  const unknown = await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/balance`, cookies,
    payload: { set: 10, hax: true },
  });
  assert.equal(unknown.statusCode, 400);

  // Audit trail: every applied change is recorded with before/after.
  const rows = db
    .prepare('SELECT * FROM balance_adjustments WHERE user_id = ? ORDER BY created_at, rowid')
    .all(playerId);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.before, r.after, r.delta]),
    [[100, 500, 400], [500, 300, -200]],
  );
  await app.close();
});

test('slots: bets are validated against min/max and balance', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'p1', balance: 300 * CREDIT });
  const cookies = await login(app, 'p1');

  const zero = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 0 },
  });
  assert.equal(zero.statusCode, 400); // below schema minimum

  // A fraction of a credit is not a rounding error to be swallowed or
  // rejected — one hundredth is the smallest stake the system has, and
  // it must go through and be charged as exactly that.
  const penny = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 1 },
  });
  assert.equal(penny.statusCode, 200, penny.body);
  assert.equal(JSON.parse(penny.body).round.bet, 1);
  const afterPenny = JSON.parse(penny.body).balance;
  assert.equal(afterPenny, 300 * CREDIT - 1 + JSON.parse(penny.body).round.payout);

  const tooBig = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 501 * CREDIT },
  });
  assert.equal(JSON.parse(tooBig.body).error, 'err_bet_too_large');

  const broke = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 400 * CREDIT },
  });
  assert.equal(JSON.parse(broke.body).error, 'err_insufficient_balance');

  const unknown = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 5 * CREDIT, hax: 1 },
  });
  assert.equal(unknown.statusCode, 400);
  assert.equal(JSON.parse(unknown.body).error, 'err_validation');

  // Only the one-hundredth spin above got through; nothing else touched
  // the balance or wrote a round.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM rounds').get().c, 1);
  const me = await app.inject({ method: 'GET', url: '/api/me', cookies });
  assert.equal(JSON.parse(me.body).user.balance, afterPenny);
  await app.close();
});

test('slots: the floor is served from the registry and the machine is honoured', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'p1', balance: 100000 });
  const cookies = await login(app, 'p1');

  const list = await app.inject({ method: 'GET', url: '/api/game/slots/machines', cookies });
  assert.equal(list.statusCode, 200, list.body);
  const floor = JSON.parse(list.body);
  assert.equal(floor.default, FLOOR_DEFAULT);
  assert.equal(floor.rtp, 0.96);
  assert.deepEqual(floor.machines.map((m) => m.id), FLOOR_IDS);

  // The ladder cabinets are retired. Their engine still exists so old
  // rounds verify, but nothing on it may be reachable from the floor.
  for (const id of MACHINE_IDS) {
    assert.ok(!FLOOR_IDS.includes(id), `retired machine ${id} is back on the floor`);
  }

  for (const view of floor.machines) {
    // The paytable a player reads is the one the server resolves
    // against — there is no second, prettier copy of the numbers.
    assert.ok(view.hit_rate > 0 && view.hit_rate < 1, view.id);
    assert.ok(view.sd > 0, view.id);
    assert.equal(view.kind, 'lines', view.id);
    const m = LINE_MACHINES[view.id];
    assert.equal(view.rows, m.rows, view.id);
    assert.equal(view.cols, m.cols, view.id);
    assert.equal(view.lines.length, m.lineCount, view.id);
    assert.deepEqual(view.symbols, m.symbols, view.id);
    assert.equal(view.wild, m.wild, view.id);
    assert.equal(view.scatter, m.scatter, view.id);
    // The wild never lands on reel 0, so a run of wilds cannot start a
    // line and the wild can never pay on its own. Its row must read as
    // zero rather than advertise a prize nobody can win.
    assert.deepEqual(view.pay[m.wild], [0, 0, 0], `${view.id} wild pays nothing`);
    assert.deepEqual(view.pay[m.scatter], [0, 0, 0], `${view.id} scatter row`);
  }

  for (const view of floor.machines) {
    const res = await app.inject({
      method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 5, machine: view.id },
    });
    assert.equal(res.statusCode, 200, res.body);
    const { round } = JSON.parse(res.body);
    assert.equal(round.outcome.machine, view.id);
    assert.equal(round.payout, Math.round(5 * round.outcome.mult));
    // Only the stops are recorded; the grid and every winning line are
    // derived from them, so the two can never disagree.
    assert.equal(round.outcome.kind, 'lines');
    assert.equal(round.outcome.stops.length, view.cols, view.id);
    assert.ok(round.outcome.stops.every((s) => Number.isInteger(s) && s >= 0), view.id);
    assert.equal(round.outcome.reels, undefined, view.id);
  }

  // An id that is not on the floor is rejected, not quietly swapped
  // for the default — a client cannot invent a paytable.
  const bogus = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 5, machine: 'not-a-machine' },
  });
  assert.equal(bogus.statusCode, 400);
  assert.equal(JSON.parse(bogus.body).error, 'err_validation');

  // So is a retired one: the engine is kept for replay, not for play.
  for (const id of MACHINE_IDS) {
    const retired = await app.inject({
      method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 5, machine: id },
    });
    assert.equal(retired.statusCode, 400, `${id} is still playable`);
  }

  // Omitting it lands on the floor's own default, never a retired id.
  const bare = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 5 },
  });
  assert.equal(JSON.parse(bare.body).round.outcome.machine, FLOOR_DEFAULT);
  assert.ok(FLOOR_IDS.includes(FLOOR_DEFAULT));
  await app.close();
});

test('slots: rounds settle atomically and the books always balance', async () => {
  const { db, app } = makeApp();
  const playerId = addUser(db, { username: 'p1', balance: 10000 });
  const cookies = await login(app, 'p1');

  let expected = 10000;
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 7 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    expected = expected - 7 + body.round.payout;
    assert.equal(body.balance, expected);
    assert.equal(body.round.net, body.round.payout - 7);
    assert.equal(body.round.nonce, i);
    assert.equal(body.round.outcome.stops.length, LINE_MACHINES[FLOOR_DEFAULT].cols);
  }

  // DB agrees with the running total: initial + sum(net) === balance.
  const dbBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(playerId).balance;
  const netSum = db.prepare('SELECT SUM(net) AS s FROM rounds WHERE user_id = ?').get(playerId).s;
  assert.equal(dbBalance, expected);
  assert.equal(10000 + netSum, dbBalance);

  // Nonce advanced once per round.
  const seed = await app.inject({ method: 'GET', url: '/api/seed', cookies });
  assert.equal(JSON.parse(seed.body).nonce, 50);

  // History returns the rounds, newest first, paginated.
  const hist = await app.inject({ method: 'GET', url: '/api/history?page=1', cookies });
  const histBody = JSON.parse(hist.body);
  assert.equal(histBody.total, 50);
  assert.equal(histBody.items.length, 20);
  assert.equal(histBody.items[0].nonce, 49);
  await app.close();
});

test('seed rotation reveals the old seed and back-fills played rounds', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'p1', balance: 1000 });
  const cookies = await login(app, 'p1');

  const before = JSON.parse((await app.inject({ method: 'GET', url: '/api/seed', cookies })).body);
  for (let i = 0; i < 3; i++) {
    await app.inject({ method: 'POST', url: '/api/game/slots/spin', cookies, payload: { bet: 1 } });
  }

  const rot = JSON.parse(
    (await app.inject({ method: 'POST', url: '/api/seed/rotate', cookies })).body,
  );
  assert.equal(rot.revealed_hash, before.server_seed_hash);
  assert.equal(
    createHash('sha256').update(rot.revealed_server_seed).digest('hex'),
    rot.revealed_hash,
    'published hash commits to the revealed seed',
  );
  assert.notEqual(rot.server_seed_hash, rot.revealed_hash);
  assert.equal(rot.nonce, 0);

  const hist = JSON.parse((await app.inject({ method: 'GET', url: '/api/history', cookies })).body);
  for (const round of hist.items) {
    assert.equal(round.server_seed, rot.revealed_server_seed);
    assert.equal(round.server_seed_hash, rot.revealed_hash);
  }
  await app.close();
});

test('client seed changes apply and unknown fields are rejected', async () => {
  const { app } = makeApp();
  const { db } = app;
  addUser(db, { username: 'p1', balance: 10 });
  const cookies = await login(app, 'p1');

  const set = await app.inject({
    method: 'POST', url: '/api/seed/client', cookies, payload: { client_seed: 'my-lucky-seed' },
  });
  assert.equal(JSON.parse(set.body).client_seed, 'my-lucky-seed');

  const bad = await app.inject({
    method: 'POST', url: '/api/seed/client', cookies, payload: { client_seed: 'spaces not ok' },
  });
  assert.equal(bad.statusCode, 400);

  const extra = await app.inject({
    method: 'POST', url: '/api/seed/client', cookies, payload: { client_seed: 'ok', extra: 1 },
  });
  assert.equal(extra.statusCode, 400);
  await app.close();
});

test('disabling a game blocks its routes; disabling a player kills the session', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const playerId = addUser(db, { username: 'p1', balance: 100 });
  const admin = await login(app, 'boss');
  const player = await login(app, 'p1');

  const off = await app.inject({
    method: 'POST', url: '/api/admin/settings', cookies: admin, payload: { games: { slots: false } },
  });
  assert.equal(off.statusCode, 200, off.body);
  const spin = await app.inject({
    method: 'POST', url: '/api/game/slots/spin', cookies: player, payload: { bet: 1 },
  });
  assert.equal(spin.statusCode, 403);
  assert.equal(JSON.parse(spin.body).error, 'err_game_disabled');

  // Unknown game key is rejected.
  const badGame = await app.inject({
    method: 'POST', url: '/api/admin/settings', cookies: admin, payload: { games: { poker: true } },
  });
  assert.equal(badGame.statusCode, 400);

  await app.inject({
    method: 'POST', url: `/api/admin/players/${playerId}/active`, cookies: admin,
    payload: { is_active: false },
  });
  const dead = await app.inject({ method: 'GET', url: '/api/me', cookies: player });
  assert.equal(dead.statusCode, 401, 'disabled account loses its session immediately');
  await app.close();
});

test('settings validation: rtp bounds and min/max bet coherence', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const cookies = await login(app, 'boss');

  const lowRtp = await app.inject({
    method: 'POST', url: '/api/admin/settings', cookies, payload: { rtp: 0.5 },
  });
  assert.equal(lowRtp.statusCode, 400);

  const crossed = await app.inject({
    method: 'POST', url: '/api/admin/settings', cookies, payload: { min_bet: 100, max_bet: 50 },
  });
  assert.equal(crossed.statusCode, 400);

  const ok = await app.inject({
    method: 'POST', url: '/api/admin/settings', cookies,
    payload: { rtp: 0.9, site_name: 'ჩემი კაზინო' },
  });
  assert.equal(ok.statusCode, 200);
  const view = JSON.parse(ok.body);
  assert.equal(view.rtp, 0.9);
  assert.equal(view.site_name, 'ჩემი კაზინო');
  await app.close();
});

test('password reset and profile updates work end to end', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const playerId = addUser(db, { username: 'p1' });
  const admin = await login(app, 'boss');

  const reset = JSON.parse(
    (await app.inject({
      method: 'POST', url: `/api/admin/players/${playerId}/reset-password`, cookies: admin,
    })).body,
  );
  const oldLogin = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'p1', password: 'password-123' },
  });
  assert.equal(oldLogin.statusCode, 401, 'old password no longer works');
  const player = await login(app, 'p1', reset.password);

  const prof = await app.inject({
    method: 'POST', url: '/api/profile', cookies: player,
    payload: { display_name: 'გიორგი', locale: 'en' },
  });
  const profBody = JSON.parse(prof.body);
  assert.equal(profBody.user.display_name, 'გიორგი');
  assert.equal(profBody.user.locale, 'en');

  const wrongCurrent = await app.inject({
    method: 'POST', url: '/api/password', cookies: player,
    payload: { current: 'wrong-wrong', next: 'brand-new-pass' },
  });
  assert.equal(JSON.parse(wrongCurrent.body).error, 'err_wrong_password');
  const changed = await app.inject({
    method: 'POST', url: '/api/password', cookies: player,
    payload: { current: reset.password, next: 'brand-new-pass' },
  });
  assert.equal(changed.statusCode, 200);
  await login(app, 'p1', 'brand-new-pass');
  await app.close();
});

test('public endpoint exposes platform config without auth', async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/public' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.site_name, 'Lucky Lion');
  assert.equal(body.rtp, 0.96);
  assert.equal(body.games.slots, true);
  await app.close();
});
