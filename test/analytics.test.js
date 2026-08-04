import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb, nowISO, setSetting } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { createBlackjackTable } from '../src/blackjack-table.js';

const SECRET = 'test-session-secret-0123456789abcdef0123456789';

function makeApp() {
  const db = openDb(':memory:');
  const app = buildApp({ db, config: { sessionSecret: SECRET, production: false }, logger: false });
  return { db, app };
}

function addUser(db, { username, password = 'password-123', role = 'player', balance = 0 }) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'ka', 1, ?, NULL)`,
  ).run(id, username, username, hashPassword(password), role, balance, nowISO());
  return id;
}

async function login(app, username, password = 'password-123') {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  assert.equal(res.statusCode, 200, res.body);
  return { sid: res.cookies.find((c) => c.name === 'sid').value };
}

const get = async (app, url, cookies) => {
  const res = await app.inject({ method: 'GET', url, cookies });
  assert.equal(res.statusCode, 200, `${url} -> ${res.body}`);
  return JSON.parse(res.body);
};

// Through the admin endpoint, which is the only way a player is really
// made — it books the opening balance as an adjustment. A row poked
// straight into users has credits behind no record, which is precisely
// the thing the reconciliation is watching for.
async function createPlayer(app, admin, username, balance) {
  const res = await app.inject({
    method: 'POST', url: '/api/admin/players', cookies: admin,
    payload: { username, balance, password: 'password-123' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return JSON.parse(res.body).user.id;
}

// The whole point of the circulation panel: credits are granted by an
// admin and after that only move by being staked. Nothing mints them and
// nothing burns them, so the balances on hand must equal granted, less
// removed, plus what play returned, less what is still in play. Asserted
// on every figure the endpoints publish, so a query that quietly drops a
// row cannot pass.
function assertCloses(view, balance) {
  assert.equal(
    view.granted - view.removed + view.net - view.in_flight.staked,
    balance,
    'granted - removed + net - in flight must equal the balance on hand',
  );
  assert.equal(view.drift, 0);
  assert.equal(view.reconciled, true);
  assert.equal(view.net, view.paid_out - view.wagered, 'settled net is payouts less stakes');
  assert.equal(view.net, view.won - view.lost, 'wins less losses is the same net');
}

test('circulation and per-player analytics close over grants, removals and real play', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const admin = await login(app, 'boss');

  const playerId = await createPlayer(app, admin, 'gia', 5000);
  const player = await login(app, 'gia');

  // an admin gives, and an admin takes away
  for (const body of [{ delta: 1500, note: 'grant' }, { delta: -400, note: 'clawback' }]) {
    const res = await app.inject({
      method: 'POST', url: `/api/admin/players/${playerId}/balance`, cookies: admin, payload: body,
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  // real rounds across three games, through the same routes a player uses
  for (let i = 0; i < 25; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/game/dice/roll', cookies: player,
      payload: { bet: 10 + i, target: 50, direction: 'under' },
    });
    assert.equal(res.statusCode, 200, res.body);
  }
  for (let i = 0; i < 15; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/game/slots/spin', cookies: player, payload: { bet: 5 },
    });
    assert.equal(res.statusCode, 200, res.body);
  }
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/game/roulette/spin', cookies: player,
      payload: { bets: [{ type: 'red', amount: 20 }] },
    });
    assert.equal(res.statusCode, 200, res.body);
  }

  const balance = db.prepare('SELECT balance FROM users WHERE id = ?').get(playerId).balance;
  const view = await get(app, `/api/admin/players/${playerId}/analytics`, admin);

  assert.equal(view.player.username, 'gia');
  assert.equal(view.player.balance, balance);
  assert.equal(view.granted, 6500, 'opening balance and the later grant');
  assert.equal(view.removed, 400);
  assert.equal(view.adjustments, 3);
  assert.equal(view.rounds, 50);
  assert.equal(view.in_flight.rounds, 0);
  assertCloses(view, balance);

  // the per-game split must account for every round and every credit
  assert.deepEqual(view.games.map((g) => g.game).sort(), ['dice', 'roulette', 'slots']);
  const sum = (key) => view.games.reduce((t, g) => t + g[key], 0);
  for (const key of ['rounds', 'wagered', 'paid_out', 'net', 'won', 'lost']) {
    assert.equal(sum(key), view[key], `per-game ${key} must sum to the total`);
  }
  assert.equal(view.games.find((g) => g.game === 'slots').rounds, 15);

  // the floor sees exactly the same money, since there is one player on it
  const floor = await get(app, '/api/admin/circulation', admin);
  assert.equal(floor.balance, balance, 'the admin holds nothing, so the floor is this player');
  assert.equal(floor.players, 1);
  assert.equal(floor.users, 2);
  assert.equal(floor.rounds, 50);
  assertCloses(floor, floor.balance);

  await app.close();
});

test('realized RTP is the money-weighted return, and its error shrinks as rounds accumulate', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const admin = await login(app, 'boss');
  addUser(db, { username: 'gia', balance: 500000 });
  const player = await login(app, 'gia');
  const playerId = db.prepare('SELECT id FROM users WHERE username = ?').get('gia').id;

  // Dice, not slots. The claim below is that the published error really
  // is a standard error and falls off as 1/sqrt(n), and a per-round
  // return has to be reasonably light-tailed for that to show at these
  // counts: on a slot machine the estimated deviation is still climbing
  // at five hundred spins, because the rare large win that sets it has
  // not been seen yet. Dice pays a fixed multiple or nothing, so the
  // deviation settles early and the law is visible rather than buried.
  // Mixed stakes, so the money-weighting is doing real work — an
  // unweighted mean of the ratios would land somewhere else.
  const roll = async (bet) => {
    const res = await app.inject({
      method: 'POST', url: '/api/game/dice/roll', cookies: player,
      payload: { bet, target: 50, direction: 'under' },
    });
    assert.equal(res.statusCode, 200, res.body);
  };

  for (let i = 0; i < 100; i++) await roll(i % 2 === 0 ? 5 : 50);
  const early = await get(app, `/api/admin/players/${playerId}/analytics`, admin);
  assert.equal(early.rtp, early.paid_out / early.wagered);
  assert.ok(early.rtp_stderr > 0, 'a hundred rounds is a sample, and a sample has a spread');

  for (let i = 0; i < 1500; i++) await roll(i % 2 === 0 ? 5 : 50);
  const late = await get(app, `/api/admin/players/${playerId}/analytics`, admin);
  assert.equal(late.rounds, 1600);
  assert.equal(late.rtp, late.paid_out / late.wagered);

  // Sixteen times the rounds should be about a quarter of the error.
  // Sampling noise moves the estimated deviation too, so this is a band.
  const ratio = early.rtp_stderr / late.rtp_stderr;
  assert.ok(ratio > 2.7 && ratio < 5.5, `stderr fell by ${ratio.toFixed(2)}x, expected about 4x`);

  // 1600 rounds against a 96% setting: the configured value must sit
  // inside a few standard errors of the realized one, or the figure is
  // not measuring what it says it measures.
  assert.ok(
    Math.abs(late.rtp - 0.96) < 4 * late.rtp_stderr,
    `realized ${late.rtp.toFixed(4)} +/- ${late.rtp_stderr.toFixed(4)} excludes the configured 0.96`,
  );

  // A single round is a point, not a sample; it has no spread to report.
  addUser(db, { username: 'solo', balance: 1000 });
  const soloId = db.prepare('SELECT id FROM users WHERE username = ?').get('solo').id;
  const solo = await login(app, 'solo');
  await app.inject({ method: 'POST', url: '/api/game/slots/spin', cookies: solo, payload: { bet: 5 } });
  const one = await get(app, `/api/admin/players/${soloId}/analytics`, admin);
  assert.equal(one.rounds, 1);
  assert.equal(one.rtp, one.paid_out / one.wagered);
  assert.equal(one.rtp_stderr, null);

  // …and no rounds at all reports nothing rather than a zero that would
  // read as a machine paying out none of what it takes.
  addUser(db, { username: 'idle', balance: 100 });
  const idleId = db.prepare('SELECT id FROM users WHERE username = ?').get('idle').id;
  const none = await get(app, `/api/admin/players/${idleId}/analytics`, admin);
  assert.equal(none.rounds, 0);
  assert.equal(none.rtp, null);
  assert.equal(none.rtp_stderr, null);
  assert.equal(none.best_round, null);

  await app.close();
});

test('best round is the best net, not the biggest payout', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const admin = await login(app, 'boss');
  const playerId = addUser(db, { username: 'gia', balance: 1000 });

  // 400 back on a 500 stake is a loss, whatever the payout column reads.
  const round = db.prepare(
    `INSERT INTO rounds (id, user_id, game, bet, payout, net, outcome_json,
                         server_seed_hash, server_seed, client_seed, nonce, created_at)
     VALUES (?, ?, 'dice', ?, ?, ?, '{}', 'hash', NULL, 'c', ?, ?)`,
  );
  round.run(randomUUID(), playerId, 500, 400, -100, 0, nowISO());
  round.run(randomUUID(), playerId, 10, 90, 80, 1, nowISO());

  const view = await get(app, `/api/admin/players/${playerId}/analytics`, admin);
  assert.equal(view.best_round.net, 80);
  assert.equal(view.best_round.payout, 90, 'the smaller payout, because it is the larger win');

  await app.close();
});

test('a player who never came out ahead gets their smallest loss, as a negative number', async () => {
  const { db, app } = makeApp();
  addUser(db, { username: 'boss', role: 'admin' });
  const admin = await login(app, 'boss');
  const playerId = addUser(db, { username: 'gia', balance: 1000 });
  const round = db.prepare(
    `INSERT INTO rounds (id, user_id, game, bet, payout, net, outcome_json,
                         server_seed_hash, server_seed, client_seed, nonce, created_at)
     VALUES (?, ?, 'dice', ?, 0, ?, '{}', 'hash', NULL, 'c', ?, ?)`,
  );
  round.run(randomUUID(), playerId, 50, -50, 0, nowISO());
  round.run(randomUUID(), playerId, 10, -10, 1, nowISO());

  const view = await get(app, `/api/admin/players/${playerId}/analytics`, admin);
  assert.equal(view.best_round.net, -10);
  assert.equal(view.won, 0);
  assert.equal(view.lost, 60);

  await app.close();
});

// The shared table writes its round row when the cards come out and
// rewrites it when the hand settles. Between those two moments the row is
// real — the stake has left the player's balance — but it has no outcome:
// payout 0, result null. Counted in the return it would read as a total
// loss on every hand still being played; dropped from the money it would
// leave the floor total short by whatever is on the felt. It has to be
// both, and this is the test that says so.
test('a hand still being played counts in the money and stays out of the return', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { db, app } = makeApp();
  setSetting(db, 'blackjack_max_bots', '0'); // an empty room, so the seats are ours
  addUser(db, { username: 'boss', role: 'admin' });
  const admin = await login(app, 'boss');
  // Deep enough to cover twenty-five doubled hands. A player who runs
  // dry is simply not dealt in, and the round would roll past with no
  // hand on the felt to look at.
  const playerId = await createPlayer(app, admin, 'gia', 50000);
  const user = { id: playerId, username: 'gia' };

  const table = createBlackjackTable(db);
  table.start();
  t.after(() => table.stop());

  const balanceOf = () => db.prepare('SELECT balance FROM users WHERE id = ?').get(playerId).balance;
  const check = async (where) => {
    const view = await get(app, `/api/admin/players/${playerId}/analytics`, admin);
    assertCloses(view, balanceOf());
    assert.equal(view.rtp === null, view.rounds === 0, `${where}: a return needs a settled round`);
    return view;
  };

  // The table seeds itself from crypto randomness and offers no way to
  // fix the shoe, so rather than reaching for one arranged moment this
  // plays a stretch of real hands and asserts the books close after
  // every single step — deal, hit, double, settle. Whatever the cards
  // do, the money and the record of it move together or this fails.
  // A tick does not run timers that were scheduled during it, and each
  // phase schedules the next one from inside the last — so the clock is
  // walked forward in short steps until the table arrives, rather than
  // jumped by one big number that would either fall short or sail
  // straight through the following deal.
  // Waits on the felt, not on a phase name. Dealt a natural the seat is
  // done where it stands, so with nobody else at the table there is no
  // acting phase at all — the round goes straight to the dealer, and a
  // wait for 'acting' would sit there until the hand was over.
  const advanceUntil = (ready, where) => {
    for (let i = 0; i < 40 && !ready(table.snapshot(user)); i++) t.mock.timers.tick(1000);
    const s = table.snapshot(user);
    assert.ok(ready(s), `${where} — phase ${s.phase}, seat ${JSON.stringify(s.seats[0])}, balance ${balanceOf()}`);
  };

  let doubles = 0;
  let dealt = 0;
  for (let round = 0; round < 25; round++) {
    table.sit(user, 0);
    table.bet(user, 100);
    await check('betting');

    // betting closes, the cards come out
    advanceUntil((s) => s.seats[0].hand.length > 0, `round ${round}: no cards were dealt`);
    assert.equal(table.snapshot(user).seats[0].hand.length, 2, 'two cards on the felt');
    dealt++;
    const live = await check('dealt');
    assert.equal(live.in_flight.rounds, 1, 'the hand on the felt is in flight');
    assert.equal(live.in_flight.staked, 100, 'and its stake is the one that left the balance');

    // Act while it is our turn: double where we can, otherwise stand,
    // checking the books between every move.
    let guard = 0;
    while (table.snapshot(user).active_seat === 0 && guard++ < 6) {
      const before = balanceOf();
      if (table.snapshot(user).seats[0].hand.length === 2) {
        table.action(user, 'double');
        doubles++;
        assert.equal(balanceOf(), before - 100, 'doubling takes a second stake');
        const view = await check('doubled');
        assert.equal(view.in_flight.staked, 200, 'and the row follows the money in the same breath');
      } else {
        table.action(user, 'stand');
        await check('stood');
      }
    }

    // dealer draws, payout lands, the felt is cleared, betting reopens
    advanceUntil(
      (s) => s.phase === 'betting' && s.seats[0].hand.length === 0,
      `round ${round}: the hand never finished`,
    );
    const settled = await check('settled');
    assert.equal(settled.in_flight.rounds, 0, 'nothing is left on the felt');
  }

  assert.equal(dealt, 25);
  assert.ok(doubles >= 15, `only ${doubles} doubles across ${dealt} hands — the double path is barely covered`);

  const done = await get(app, `/api/admin/players/${playerId}/analytics`, admin);
  assert.equal(done.rounds, dealt, 'every hand dealt ended up a settled round');
  assert.equal(done.games[0].game, 'blackjack');
  assert.equal(done.games[0].rounds, dealt);

  await app.close();
});

test('analytics are admin-only', async () => {
  const { db, app } = makeApp();
  const playerId = addUser(db, { username: 'gia', balance: 100 });
  const player = await login(app, 'gia');
  for (const url of ['/api/admin/circulation', `/api/admin/players/${playerId}/analytics`]) {
    const anon = await app.inject({ method: 'GET', url });
    assert.equal(anon.statusCode, 401, `anonymous ${url}`);
    const res = await app.inject({ method: 'GET', url, cookies: player });
    assert.equal(res.statusCode, 403, `player ${url}`);
    assert.equal(JSON.parse(res.body).error, 'err_forbidden');
  }
  await app.close();
});
