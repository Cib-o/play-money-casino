import test from 'node:test';
import assert from 'node:assert/strict';
import { uniform } from '../src/rng.js';
import {
  MULT,
  WEIGHT,
  SYMBOL_COUNT,
  buildTable,
  theoreticalReturn,
  pickIndex,
  reelsFor,
  payoutFor,
  spin,
} from '../src/games/slots.js';

const SEED = 'f'.repeat(64);
const RTPS = [0.9, 0.96, 0.98];

test('theoretical return equals the configured RTP within 1e-12', () => {
  for (const rtp of RTPS) {
    const er = theoreticalReturn(rtp);
    assert.ok(
      Math.abs(er - rtp) < 1e-12,
      `rtp ${rtp}: expected return ${er}, diff ${Math.abs(er - rtp)}`,
    );
  }
});

test('the loss region is an explicit entry at index 0', () => {
  for (const rtp of RTPS) {
    const t = buildTable(rtp);
    assert.equal(t.outs[0], 0);
    assert.ok(Math.abs(t.cum[0] - (1 - t.q)) < 1e-15);
    assert.equal(t.outs.length, MULT.length + 1);
    // Monotonically increasing thresholds, ending at ~1.
    for (let i = 1; i < t.cum.length; i++) assert.ok(t.cum[i] > t.cum[i - 1]);
    assert.ok(Math.abs(t.cum[t.cum.length - 1] - 1) < 1e-12);
  }
});

// One shared 2,000,000-draw stream, evaluated against each RTP's
// table. The tolerance is four standard errors with the standard
// deviation taken from the paytable itself — the 2000x tail pushes sd
// to ~11.7, so SE over 2M rounds is ~0.008. A percentage band tighter
// than that would measure luck, not correctness.
test('empirical return over 2,000,000 rounds is within four standard errors', () => {
  const N = 2_000_000;
  const us = new Float64Array(N);
  for (let nonce = 0; nonce < N; nonce++) {
    us[nonce] = uniform(SEED, 'empirical', nonce);
  }

  const sumW = WEIGHT.reduce((a, b) => a + b, 0);
  for (const rtp of RTPS) {
    const table = buildTable(rtp);
    let total = 0;
    let hits = 0;
    for (let n = 0; n < N; n++) {
      const mult = table.outs[pickIndex(table, us[n])];
      total += mult;
      if (mult > 0) hits++;
    }
    const mean = total / N;

    // sd from the paytable: E[m^2] - E[m]^2, E[m] = rtp exactly.
    let em2 = 0;
    for (let i = 0; i < MULT.length; i++) {
      em2 += MULT[i] * MULT[i] * ((table.q * WEIGHT[i]) / sumW);
    }
    const se = Math.sqrt(em2 - rtp * rtp) / Math.sqrt(N);
    assert.ok(
      Math.abs(mean - rtp) < 4 * se,
      `rtp ${rtp}: empirical ${mean.toFixed(6)}, |diff| ${Math.abs(mean - rtp).toFixed(6)} vs 4se ${(4 * se).toFixed(6)}`,
    );

    // Hit rate must track q — this is what breaks when the loss entry
    // is missing from the table (every round becomes a win).
    const hitRate = hits / N;
    const seHit = Math.sqrt((table.q * (1 - table.q)) / N);
    assert.ok(
      Math.abs(hitRate - table.q) < 4 * seHit,
      `rtp ${rtp}: hit rate ${hitRate.toFixed(4)} vs q ${table.q.toFixed(4)}`,
    );
  }
});

test('a losing round never renders three of a kind; a win always does', () => {
  let losses = 0;
  let wins = 0;
  for (let nonce = 0; nonce < 20000; nonce++) {
    const out = spin({ serverSeed: SEED, clientSeed: 'display', nonce, rtp: 0.96, bet: 10 });
    for (const r of out.reels) {
      assert.ok(Number.isInteger(r) && r >= 0 && r < SYMBOL_COUNT);
    }
    const threeOfAKind = out.reels[0] === out.reels[1] && out.reels[1] === out.reels[2];
    if (out.mult === 0) {
      losses++;
      assert.ok(!threeOfAKind, `loss rendered as a win at nonce ${nonce}`);
      assert.equal(out.payout, 0);
    } else {
      wins++;
      assert.ok(threeOfAKind, `win not rendered as three of a kind at nonce ${nonce}`);
      assert.equal(out.reels[0], MULT.indexOf(out.mult));
    }
  }
  assert.ok(losses > 10000 && wins > 3000, `losses ${losses}, wins ${wins}`);
});

test('spins are deterministic for identical seeds and nonce', () => {
  for (let nonce = 0; nonce < 50; nonce++) {
    const a = spin({ serverSeed: SEED, clientSeed: 'det', nonce, rtp: 0.96, bet: 25 });
    const b = spin({ serverSeed: SEED, clientSeed: 'det', nonce, rtp: 0.96, bet: 25 });
    assert.deepEqual(a, b);
  }
  // A single outcome can collide across seeds (both may land in the
  // same bucket); a whole sequence must not.
  const seq = (serverSeed) =>
    Array.from({ length: 20 }, (_, nonce) =>
      spin({ serverSeed, clientSeed: 'det', nonce, rtp: 0.96, bet: 25 }),
    );
  assert.notDeepEqual(seq(SEED), seq('e'.repeat(64)));
});

test('payouts are integer credits', () => {
  assert.equal(payoutFor(10, 0.5), 5);
  assert.equal(payoutFor(3, 2), 6);
  assert.equal(payoutFor(7, 2000), 14000);
  for (const bet of [1, 2, 3, 500]) {
    for (const mult of MULT) {
      assert.ok(Number.isInteger(payoutFor(bet, mult)));
    }
  }
});

test('reels are reproducible from the recorded index', () => {
  // The verifier recomputes reels from (seeds, nonce, index) alone.
  for (let nonce = 0; nonce < 200; nonce++) {
    const out = spin({ serverSeed: SEED, clientSeed: 'reels', nonce, rtp: 0.96, bet: 5 });
    const index = out.mult === 0 ? 0 : MULT.indexOf(out.mult) + 1;
    assert.deepEqual(
      reelsFor({ serverSeed: SEED, clientSeed: 'reels', nonce, index }),
      out.reels,
    );
  }
});
