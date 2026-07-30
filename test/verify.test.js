import test from 'node:test';
import assert from 'node:assert/strict';
import { uniform as serverUniform, sha256hex as serverSha256 } from '../src/rng.js';
import { spin } from '../src/games/slots.js';
import { spinNumber, settle } from '../src/games/roulette.js';
import { roll } from '../src/games/dice.js';
import { makeDraw, replay, dealerPlay } from '../src/games/blackjack.js';
import {
  uniform as clientUniform,
  sha256Hex as clientSha256,
  verifySlots,
  verifyRoulette,
  verifyDice,
  verifyBlackjack,
  verifyBlackjackTable,
} from '../public/js/verify-core.js';

// The browser verifier must mirror the server byte for byte. Running
// the same module under Node's WebCrypto and comparing against the
// node:crypto implementation pins that equivalence in CI — if the two
// ever diverge, verification breaks loudly here first.

const SEED = '9'.repeat(64);

test('client uniform() reproduces the server stream exactly', async () => {
  for (let nonce = 0; nonce < 50; nonce++) {
    for (const cursor of [0, 1, 2, 3, 7]) {
      assert.equal(
        await clientUniform(SEED, 'mirror', nonce, cursor),
        serverUniform(SEED, 'mirror', nonce, cursor),
        `nonce ${nonce} cursor ${cursor}`,
      );
    }
  }
});

test('client sha256 matches the server commitment hash', async () => {
  for (const input of [SEED, 'abc', 'კრედიტი-სათამაშო-ქულაა']) {
    assert.equal(await clientSha256(input), serverSha256(input));
  }
});

test('verifyRoulette reproduces the server pocket and settlement', async () => {
  const bets = [
    { type: 'straight', selection: 17, amount: 5 },
    { type: 'split', selection: [17, 20], amount: 3 },
    { type: 'red', amount: 10 },
    { type: 'dozen', selection: 1, amount: 4 },
    { type: 'column', selection: 0, amount: 2 },
  ];
  for (let nonce = 0; nonce < 300; nonce++) {
    const number = spinNumber({ serverSeed: SEED, clientSeed: 'wheel', nonce });
    const server = settle(bets, number);
    const client = await verifyRoulette({ serverSeed: SEED, clientSeed: 'wheel', nonce, bets });
    assert.equal(client.number, number, `pocket at nonce ${nonce}`);
    assert.equal(client.payout, server.payout, `payout at nonce ${nonce}`);
  }
});

test('verifyDice reproduces the server roll, win flag and multiplier', async () => {
  for (const [target, direction] of [[50, 'under'], [10, 'under'], [80, 'over'], [2, 'under'], [98, 'over']]) {
    for (let nonce = 0; nonce < 100; nonce++) {
      const server = roll({
        serverSeed: SEED, clientSeed: 'dice', nonce, rtp: 0.96, bet: 100, target, direction,
      });
      const client = await verifyDice({
        serverSeed: SEED, clientSeed: 'dice', nonce, rtp: 0.96, target, direction,
      });
      assert.equal(client.r, server.r);
      assert.equal(client.win, server.win);
      assert.equal(client.mult, server.mult);
    }
  }
});

test('verifyBlackjack replays server hands for every action pattern', async () => {
  const patterns = [[], ['stand'], ['hit', 'stand'], ['hit', 'hit', 'stand'], ['double']];
  for (const actions of patterns) {
    for (let nonce = 0; nonce < 60; nonce++) {
      const server = replay({
        draw: makeDraw({ serverSeed: SEED, clientSeed: 'bj', nonce }),
        actions,
      });
      const client = await verifyBlackjack({
        serverSeed: SEED, clientSeed: 'bj', nonce, actions,
      });
      assert.deepEqual(client.player, server.player, `player ${actions} nonce ${nonce}`);
      assert.deepEqual(client.dealer, server.dealer, `dealer ${actions} nonce ${nonce}`);
    }
  }
});

test('verifyBlackjackTable mirrors the shared-table per-seat dealing', async () => {
  const seed = '3'.repeat(64);
  const cardAt = (tag, nonce, cur) => Math.floor(serverUniform(seed, `table:${tag}`, nonce, cur) * 52);
  const patterns = [[], ['stand'], ['hit', 'stand'], ['double'], ['hit', 'hit', 'stand']];
  for (const seat of [0, 1, 3, 6]) {
    for (const actions of patterns) {
      for (let nonce = 1; nonce < 30; nonce++) {
        const player = [cardAt(String(seat), nonce, 0), cardAt(String(seat), nonce, 1)];
        let cur = 1;
        for (const a of actions) if (a === 'hit' || a === 'double') player.push(cardAt(String(seat), nonce, ++cur));
        const dealer = dealerPlay(
          [cardAt('d', nonce, 0), cardAt('d', nonce, 1)],
          (c) => cardAt('d', nonce, c),
          2,
        ).hand;
        const out = await verifyBlackjackTable({ serverSeed: seed, nonce, seat, actions });
        assert.deepEqual(out.player, player, `player seat ${seat} ${actions} n${nonce}`);
        assert.deepEqual(out.dealer, dealer, `dealer seat ${seat} ${actions} n${nonce}`);
      }
    }
  }
});

test('verifySlots reproduces server spins across RTPs', async () => {
  for (const rtp of [0.9, 0.96, 0.98]) {
    for (let nonce = 0; nonce < 200; nonce++) {
      const server = spin({ serverSeed: SEED, clientSeed: 'replay', nonce, rtp, bet: 10 });
      const client = await verifySlots({ serverSeed: SEED, clientSeed: 'replay', nonce, rtp });
      assert.equal(client.mult, server.mult, `mult at rtp ${rtp} nonce ${nonce}`);
      assert.deepEqual(client.reels, server.reels, `reels at rtp ${rtp} nonce ${nonce}`);
    }
  }
});
