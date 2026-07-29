import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RED,
  PAYOUTS,
  validSplit,
  validateBet,
  betWins,
  spinNumber,
  settle,
} from '../src/games/roulette.js';

const SEED = 'c'.repeat(64);

test('the red set is the standard 18 numbers', () => {
  assert.equal(RED.size, 18);
  for (const n of RED) assert.ok(n >= 1 && n <= 36);
  // black is the complement inside 1..36
  const black = [...Array(36).keys()].map((i) => i + 1).filter((n) => !RED.has(n));
  assert.equal(black.length, 18);
});

test('split adjacency follows the physical layout', () => {
  for (const [a, b] of [[0, 1], [0, 2], [0, 3], [1, 2], [2, 3], [1, 4], [35, 36], [33, 36], [17, 20]]) {
    assert.ok(validSplit(a, b), `${a}-${b} should be valid`);
  }
  for (const [a, b] of [[3, 4], [6, 7], [1, 3], [0, 4], [2, 2], [1, 5], [34, 36], [0, 36], [36, 39]]) {
    assert.ok(!validSplit(a, b), `${a}-${b} should be invalid`);
  }
});

test('bet validation rejects malformed selections', () => {
  assert.ok(validateBet({ type: 'straight', selection: 0, amount: 1 }));
  assert.ok(validateBet({ type: 'straight', selection: 36, amount: 1 }));
  assert.ok(!validateBet({ type: 'straight', selection: 37, amount: 1 }));
  assert.ok(!validateBet({ type: 'straight', selection: 1.5, amount: 1 }));
  assert.ok(validateBet({ type: 'split', selection: [16, 19], amount: 1 }));
  assert.ok(!validateBet({ type: 'split', selection: [16, 18], amount: 1 }));
  assert.ok(validateBet({ type: 'red', amount: 1 }));
  assert.ok(!validateBet({ type: 'red', selection: 5, amount: 1 }));
  assert.ok(validateBet({ type: 'dozen', selection: 2, amount: 1 }));
  assert.ok(!validateBet({ type: 'dozen', selection: 3, amount: 1 }));
  assert.ok(!validateBet({ type: 'trio', selection: 1, amount: 1 }));
});

test('betWins matches the classic rules on edge pockets', () => {
  assert.ok(betWins({ type: 'straight', selection: 0 }, 0));
  assert.ok(!betWins({ type: 'red' }, 0));
  assert.ok(!betWins({ type: 'black' }, 0));
  assert.ok(!betWins({ type: 'odd' }, 0));
  assert.ok(!betWins({ type: 'even' }, 0));
  assert.ok(!betWins({ type: 'dozen', selection: 0 }, 0));
  assert.ok(betWins({ type: 'dozen', selection: 0 }, 1));
  assert.ok(betWins({ type: 'dozen', selection: 0 }, 12));
  assert.ok(betWins({ type: 'dozen', selection: 1 }, 13));
  assert.ok(betWins({ type: 'dozen', selection: 2 }, 36));
  assert.ok(betWins({ type: 'column', selection: 0 }, 1));
  assert.ok(betWins({ type: 'column', selection: 1 }, 2));
  assert.ok(betWins({ type: 'column', selection: 2 }, 3));
  assert.ok(betWins({ type: 'column', selection: 2 }, 36));
  assert.ok(betWins({ type: 'even' }, 18));
  assert.ok(betWins({ type: 'odd' }, 19));
  assert.ok(betWins({ type: 'split', selection: [0, 2] }, 0));
  assert.ok(betWins({ type: 'split', selection: [0, 2] }, 2));
  assert.ok(!betWins({ type: 'split', selection: [0, 2] }, 1));
});

test('every bet type returns exactly 36 units across all 37 pockets', () => {
  // Total return over the whole wheel is 36 for a 1-unit bet of any
  // type — that single identity is the 1/37 house edge.
  const bets = [
    { type: 'straight', selection: 17, amount: 1 },
    { type: 'split', selection: [17, 20], amount: 1 },
    { type: 'red', amount: 1 },
    { type: 'black', amount: 1 },
    { type: 'odd', amount: 1 },
    { type: 'even', amount: 1 },
    { type: 'dozen', selection: 1, amount: 1 },
    { type: 'column', selection: 2, amount: 1 },
  ];
  for (const bet of bets) {
    let total = 0;
    for (let n = 0; n <= 36; n++) {
      total += settle([bet], n).payout;
    }
    assert.equal(total, 36, `${bet.type} returned ${total}`);
  }
});

test('spinNumber is deterministic, in range, and covers all pockets', () => {
  const seen = new Set();
  for (let nonce = 0; nonce < 2000; nonce++) {
    const n = spinNumber({ serverSeed: SEED, clientSeed: 'wheel', nonce });
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 36);
    assert.equal(n, spinNumber({ serverSeed: SEED, clientSeed: 'wheel', nonce }));
    seen.add(n);
  }
  assert.equal(seen.size, 37);
});

test('pocket distribution is flat within four standard errors', () => {
  const N = 74000;
  const counts = new Array(37).fill(0);
  for (let nonce = 0; nonce < N; nonce++) {
    counts[spinNumber({ serverSeed: SEED, clientSeed: 'flat', nonce })]++;
  }
  const expected = N / 37;
  const tolerance = 4 * Math.sqrt(N * (1 / 37) * (36 / 37));
  for (let n = 0; n <= 36; n++) {
    assert.ok(
      Math.abs(counts[n] - expected) < tolerance,
      `pocket ${n}: ${counts[n]} vs ${expected.toFixed(1)}`,
    );
  }
});

test('settlement sums multiple bets and reports per-bet results', () => {
  const bets = [
    { type: 'straight', selection: 7, amount: 10 },
    { type: 'red', amount: 20 },
    { type: 'dozen', selection: 0, amount: 5 },
  ];
  const { payout, results } = settle(bets, 7); // 7 is red, 1st dozen
  assert.equal(payout, 10 * 36 + 20 * 2 + 5 * 3);
  assert.deepEqual(results.map((r) => r.win), [true, true, true]);
  const loss = settle(bets, 26); // 26 is black, 3rd dozen
  assert.equal(loss.payout, 0);
});
