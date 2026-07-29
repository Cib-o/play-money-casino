import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_TARGET,
  MAX_TARGET,
  validTarget,
  winChance,
  multiplier,
  roll,
} from '../src/games/dice.js';

const SEED = 'd'.repeat(64);
const RTPS = [0.9, 0.96, 0.98];

test('expected return equals RTP exactly for every target and direction', () => {
  for (const rtp of RTPS) {
    for (let target = MIN_TARGET; target <= MAX_TARGET; target++) {
      for (const direction of ['under', 'over']) {
        const p = winChance(target, direction);
        const er = p * multiplier(rtp, target, direction);
        assert.ok(
          Math.abs(er - rtp) < 1e-12,
          `rtp ${rtp} ${direction} ${target}: ER ${er}`,
        );
      }
    }
  }
});

test('win probabilities are the exact rationals over 10,000 roll values', () => {
  // Enumerate every possible roll value k/100 and count wins — the
  // count must equal the closed-form probability times 10,000.
  for (const target of [2, 33, 50, 77, 98]) {
    let under = 0;
    let over = 0;
    for (let k = 0; k < 10000; k++) {
      const r = k / 100;
      if (r < target) under++;
      if (r > target) over++;
    }
    assert.equal(under, 100 * target);
    assert.equal(over, 9999 - 100 * target);
    // and the closed forms are exactly these counts over 10,000
    assert.equal(winChance(target, 'under'), under / 10000);
    assert.equal(winChance(target, 'over'), over / 10000);
  }
});

test('target validation and multiplier bounds', () => {
  assert.ok(validTarget(2) && validTarget(98) && validTarget(50));
  assert.ok(!validTarget(1) && !validTarget(99) && !validTarget(50.5) && !validTarget('50'));
  // Extremes at RTP 0.96: 2-under is the longest shot.
  assert.ok(Math.abs(multiplier(0.96, 2, 'under') - 48) < 1e-12);
  assert.ok(multiplier(0.96, 98, 'over') > 48 && multiplier(0.96, 98, 'over') < 48.3);
  assert.ok(Math.abs(multiplier(0.96, 50, 'under') - 1.92) < 1e-12);
});

test('rolls are deterministic, in range, and two-decimal', () => {
  for (let nonce = 0; nonce < 500; nonce++) {
    const a = roll({ serverSeed: SEED, clientSeed: 'dice', nonce, rtp: 0.96, bet: 10, target: 50, direction: 'under' });
    const b = roll({ serverSeed: SEED, clientSeed: 'dice', nonce, rtp: 0.96, bet: 10, target: 50, direction: 'under' });
    assert.deepEqual(a, b);
    assert.ok(a.r >= 0 && a.r <= 99.99);
    assert.ok(Number.isInteger(Math.round(a.r * 100)));
    assert.ok(Math.abs(a.r * 100 - Math.round(a.r * 100)) < 1e-9);
  }
});

test('empirical return over a fixed 200,000-roll stream is within four standard errors', () => {
  // bet 10000 at 50-under: multiplier 1.92 exactly, so bet·mult is an
  // integer and rounding adds no noise to the measurement.
  const N = 200000;
  const bet = 10000;
  const target = 50;
  const p = winChance(target, 'under');
  const mult = multiplier(0.96, target, 'under');
  let total = 0;
  let wins = 0;
  for (let nonce = 0; nonce < N; nonce++) {
    const out = roll({ serverSeed: SEED, clientSeed: 'empirical', nonce, rtp: 0.96, bet, target, direction: 'under' });
    total += out.payout;
    if (out.win) wins++;
  }
  const meanReturn = total / (N * bet);
  const se = (mult * Math.sqrt(p * (1 - p))) / Math.sqrt(N);
  assert.ok(
    Math.abs(meanReturn - 0.96) < 4 * se,
    `mean ${meanReturn.toFixed(5)} vs 0.96 ± ${(4 * se).toFixed(5)}`,
  );
  const seHit = Math.sqrt(p * (1 - p) / N);
  assert.ok(Math.abs(wins / N - p) < 4 * seHit, `hit rate ${wins / N}`);
});
