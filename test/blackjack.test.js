import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  handTotal,
  isBlackjack,
  dealerPlay,
  settleOutcome,
  makeDraw,
  replay,
} from '../src/games/blackjack.js';
import { inRound } from '../src/blackjack-table.js';
import { openDb, nowISO } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { buildApp } from '../src/app.js';

// Card indexes: rank = card % 13 (0=A, 1=2 … 8=9, 9=10, 10=J, 11=Q, 12=K).
const A = 0, TWO = 1, FIVE = 4, SIX = 5, NINE = 8, TEN = 9, K = 12;

test('hand totals demote aces correctly', () => {
  assert.deepEqual(handTotal([A, SIX]), { total: 17, soft: true });
  assert.deepEqual(handTotal([A, SIX, TEN]), { total: 17, soft: false });
  assert.deepEqual(handTotal([A, A]), { total: 12, soft: true });
  assert.deepEqual(handTotal([A, A, NINE]), { total: 21, soft: true });
  assert.deepEqual(handTotal([TEN, K]), { total: 20, soft: false });
  assert.deepEqual(handTotal([TEN, K, TWO]), { total: 22, soft: false });
  assert.ok(isBlackjack([A, K]));
  assert.ok(isBlackjack([TEN, A]));
  assert.ok(!isBlackjack([A, SIX, FIVE, NINE])); // 21 in four cards is not a natural
});

test('the dealer stands on soft 17 and draws below it', () => {
  const queue = [TEN, FIVE, NINE];
  const draw = () => queue.shift();
  // Soft 17 (A+6): stands immediately — S17 rule.
  assert.deepEqual(dealerPlay([A, SIX], draw, 4).hand, [A, SIX]);
  // Soft 16 (A+5): draws TEN (ace demotes to hard 16, still short),
  // then FIVE lands on 21 — four cards total.
  const soft16 = dealerPlay([A, FIVE], draw, 4);
  assert.equal(soft16.hand.length, 4);
  assert.equal(handTotal(soft16.hand).total, 21);
});

test('dealer keeps drawing through demoted aces to at least 17', () => {
  const queue = [TEN, FIVE, SIX];
  const draw = () => queue.shift();
  const out = dealerPlay([A, FIVE], draw, 4);
  // A+5 (16 soft) → +10 = hard 16 → +5 = 21? no: A(1)+5+10+5 = 21
  assert.ok(handTotal(out.hand).total >= 17);
});

test('settlement covers every outcome class', () => {
  const base = { bet: 10, doubled: false };
  // Natural blackjack pays 3:2.
  assert.deepEqual(settleOutcome([A, K], [TEN, NINE], base), { result: 'blackjack', payout: 25 });
  // Both naturals push the stake back.
  assert.deepEqual(settleOutcome([A, K], [TEN, A], base), { result: 'push', payout: 10 });
  // Dealer natural beats a made 21? No — a non-natural 21 loses to it.
  assert.deepEqual(settleOutcome([SIX, FIVE, TEN], [A, K], base), { result: 'lose', payout: 0 });
  // Plain win/lose/push at 2x stake.
  assert.deepEqual(settleOutcome([TEN, NINE], [TEN, SIX, TWO], base), { result: 'win', payout: 20 });
  assert.deepEqual(settleOutcome([TEN, SIX], [TEN, NINE], base), { result: 'lose', payout: 0 });
  assert.deepEqual(settleOutcome([TEN, NINE], [TEN, NINE], base), { result: 'push', payout: 10 });
  // Player bust loses even if the dealer would also bust later.
  assert.deepEqual(settleOutcome([TEN, SIX, K], [TEN, SIX], base), { result: 'lose', payout: 0 });
  // Dealer bust pays.
  assert.deepEqual(settleOutcome([TEN, SIX], [TEN, SIX, K], base), { result: 'win', payout: 20 });
  // Doubled stakes settle at 2x the doubled amount.
  assert.deepEqual(
    settleOutcome([FIVE, SIX, TEN], [TEN, NINE, FIVE], { bet: 10, doubled: true }),
    { result: 'win', payout: 40 },
  );
  // Blackjack payout rounds to integer credits on odd bets.
  assert.deepEqual(settleOutcome([A, K], [TEN, NINE], { bet: 5, doubled: false }).payout, 13);
});

test('rounds replay deterministically from seeds and actions', () => {
  const seeds = { serverSeed: 'b'.repeat(64), clientSeed: 'bj', nonce: 7 };
  const draw = makeDraw(seeds);
  const a = replay({ draw, actions: ['hit', 'stand'] });
  const b = replay({ draw: makeDraw(seeds), actions: ['hit', 'stand'] });
  assert.deepEqual(a, b);
  for (const card of [...a.player, ...a.dealer]) {
    assert.ok(Number.isInteger(card) && card >= 0 && card < 52);
  }
  // Different nonce, different cards.
  const c = replay({ draw: makeDraw({ ...seeds, nonce: 8 }), actions: ['hit', 'stand'] });
  assert.notDeepEqual(a, c);
});

// ── HTTP flow ─────────────────────────────────────────────────────
const SECRET = 'test-session-secret-0123456789abcdef0123456789';

function makeApp() {
  const db = openDb(':memory:');
  const app = buildApp({ db, config: { sessionSecret: SECRET, production: false }, logger: false });
  return { db, app };
}

function addPlayer(db, balance) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
     VALUES (?, 'p1', 'p1', ?, 'player', ?, 'ka', 1, ?, NULL)`,
  ).run(id, hashPassword('password-123'), balance, nowISO());
  return id;
}

async function login(app) {
  const res = await app.inject({
    method: 'POST', url: '/api/login', payload: { username: 'p1', password: 'password-123' },
  });
  return { sid: res.cookies.find((c) => c.name === 'sid').value };
}

// A seat showing cards but an empty betspot is a hand nobody staked
// anything on. It used to happen every round: manageBots sits ~22% of
// the bots out by zeroing their bet, but the deal let every bot in
// regardless, so those seats were dealt and played with no chip under
// them — indistinguishable, from the other chairs, from a bet that had
// simply failed to render.
test('no seat is dealt in without a wager behind it', () => {
  const seat = (over) => ({ kind: 'empty', bet: 0, baseBet: 0, ...over });

  assert.equal(inRound(seat({ kind: 'bot', bet: 25 })), true, 'betting bot plays');
  assert.equal(inRound(seat({ kind: 'bot', bet: 0 })), false, 'bot sitting out is dealt in');

  // A player is in only once closeBetting has actually charged them:
  // `bet` is what they asked for, `baseBet` is what the table took.
  assert.equal(inRound(seat({ kind: 'player', bet: 5, baseBet: 5 })), true, 'charged player plays');
  assert.equal(
    inRound(seat({ kind: 'player', bet: 5, baseBet: 0 })),
    false,
    'player whose bet never cleared is dealt in',
  );
  assert.equal(inRound(seat({ kind: 'player' })), false, 'player with no bet');
  assert.equal(inRound(seat({})), false, 'empty seat');
});

test('blackjack over HTTP: deal debits, actions advance, resolution pays and records', async () => {
  const { db, app } = makeApp();
  const playerId = addPlayer(db, 1000);
  const cookies = await login(app);

  // Playing several rounds to cross both immediate and interactive paths.
  let balance = 1000;
  for (let i = 0; i < 25; i++) {
    const deal = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/game/blackjack/deal', cookies, payload: { bet: 10 },
      })).body,
    );
    if (deal.round) {
      // Natural on either side — settled in one shot.
      balance = balance - 10 + deal.round.payout;
      assert.equal(deal.balance, balance);
      continue;
    }
    assert.equal(deal.balance, balance - 10);
    assert.equal(deal.state.player.length, 2);
    assert.ok(deal.state.dealer_up !== undefined);
    // Double-deal must be rejected while a round is open.
    const again = await app.inject({
      method: 'POST', url: '/api/game/blackjack/deal', cookies, payload: { bet: 10 },
    });
    assert.equal(JSON.parse(again.body).error, 'err_round_in_progress');
    // Rotation is blocked mid-round: it would reveal the dealer's cards.
    const rotate = await app.inject({ method: 'POST', url: '/api/seed/rotate', cookies });
    assert.equal(JSON.parse(rotate.body).error, 'err_round_in_progress');
    // The open round survives a "reconnect".
    const resumed = JSON.parse(
      (await app.inject({ method: 'GET', url: '/api/game/blackjack/state', cookies })).body,
    );
    assert.equal(resumed.state.bet, 10);

    const stand = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/game/blackjack/stand', cookies })).body,
    );
    assert.ok(stand.round, 'stand resolves the round');
    assert.equal(stand.round.outcome.dealer.length >= 2, true);
    assert.ok(handTotal(stand.round.outcome.dealer).total >= 17);
    balance = balance - 10 + stand.round.payout;
    assert.equal(stand.balance, balance);
  }

  // Books balance: initial + sum(net) === final.
  const netSum = db.prepare('SELECT SUM(net) AS s FROM rounds WHERE user_id = ?').get(playerId).s;
  const dbBalance = db.prepare('SELECT balance FROM users WHERE id = ?').get(playerId).balance;
  assert.equal(1000 + netSum, dbBalance);
  assert.equal(dbBalance, balance);
  // No dangling state.
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM blackjack_states').get().c, 0);

  // Actions without an open round are rejected.
  for (const action of ['hit', 'stand', 'double']) {
    const res = await app.inject({ method: 'POST', url: `/api/game/blackjack/${action}`, cookies });
    assert.equal(JSON.parse(res.body).error, 'err_no_round');
  }
  await app.close();
});

test('recorded blackjack rounds replay from their outcome', async () => {
  const { db, app } = makeApp();
  addPlayer(db, 5000);
  const cookies = await login(app);

  for (let i = 0; i < 15; i++) {
    const deal = JSON.parse(
      (await app.inject({
        method: 'POST', url: '/api/game/blackjack/deal', cookies, payload: { bet: 5 },
      })).body,
    );
    if (!deal.round) {
      await app.inject({ method: 'POST', url: '/api/game/blackjack/stand', cookies });
    }
  }
  await app.inject({ method: 'POST', url: '/api/seed/rotate', cookies });
  const hist = JSON.parse((await app.inject({ method: 'GET', url: '/api/history', cookies })).body);
  assert.ok(hist.total >= 15);
  for (const round of hist.items.filter((r) => r.game === 'blackjack')) {
    assert.ok(round.server_seed, 'revealed after rotation');
    const draw = makeDraw({
      serverSeed: round.server_seed,
      clientSeed: round.client_seed,
      nonce: round.nonce,
    });
    const replayed = replay({ draw, actions: round.outcome.actions });
    assert.deepEqual(replayed.player, round.outcome.player, `round ${round.id} player`);
    assert.deepEqual(replayed.dealer, round.outcome.dealer, `round ${round.id} dealer`);
  }
  await app.close();
});
