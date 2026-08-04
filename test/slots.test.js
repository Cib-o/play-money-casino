import test from 'node:test';
import assert from 'node:assert/strict';
import { uniform } from '../src/rng.js';
import { THEMES, theme, FALLBACK_THEME } from '../public/js/slot-themes.js';
import {
  MULT,
  WEIGHT,
  SYMBOL_COUNT,
  MACHINES,
  MACHINE_IDS,
  DEFAULT_MACHINE,
  getMachine,
  buildTable,
  theoreticalReturn,
  standardDeviation,
  volatilityBand,
  machineView,
  pickIndex,
  reelsFor,
  payoutFor,
  spin,
} from '../src/games/slots.js';

const SEED = 'f'.repeat(64);
const RTPS = [0.9, 0.96, 0.98];
// The widest band an admin can configure (src/routes/admin.js).
const MAX_RTP = 0.99;

// theoreticalReturn differences the cumulative array on purpose: that
// is the array pickIndex actually reads, so this measures the table in
// use rather than an idealised copy of it. The cost is precision — the
// top tier's probability is the gap between two doubles that both sit
// within 1e-6 of 1, so it carries about one ULP of error, and that
// error is then multiplied by the top payout. The tolerance therefore
// scales with the ladder's top multiplier; measured error is ~1.1e-16
// per unit of top multiplier on every machine, so this leaves ~9x
// headroom while still pinning roughly fifteen significant digits.
test('every machine returns exactly its configured RTP', () => {
  for (const id of MACHINE_IDS) {
    const tolerance = getMachine(id).mult[getMachine(id).mult.length - 1] * 1e-15;
    for (const rtp of [0.8, ...RTPS, MAX_RTP]) {
      const er = theoreticalReturn(rtp, id);
      assert.ok(
        Math.abs(er - rtp) < tolerance,
        `${id} at rtp ${rtp}: expected return ${er}, diff ${Math.abs(er - rtp)} vs ${tolerance}`,
      );
    }
  }
});

// The calibration q = rtp * sumW / sumWM only holds while q <= 1. A new
// paytable whose average win multiplier is too small would need to pay
// out on more than every round to reach the RTP, and the table would
// silently clamp. This is the guard rail for adding machines.
test('no machine needs a win probability above 1 at the highest RTP', () => {
  for (const id of MACHINE_IDS) {
    const { q } = buildTable(MAX_RTP, id);
    assert.ok(q > 0 && q < 1, `${id}: q ${q} at rtp ${MAX_RTP}`);
    // Leave real headroom rather than sitting on the boundary.
    assert.ok(q < 0.9, `${id}: q ${q} is uncomfortably close to 1`);
  }
});

test('the loss region is an explicit entry at index 0 on every machine', () => {
  for (const id of MACHINE_IDS) {
    const m = getMachine(id);
    for (const rtp of RTPS) {
      const t = buildTable(rtp, id);
      assert.equal(t.outs[0], 0);
      assert.ok(Math.abs(t.cum[0] - (1 - t.q)) < 1e-15);
      assert.equal(t.outs.length, m.mult.length + 1);
      // Monotonically increasing thresholds, ending at ~1.
      for (let i = 1; i < t.cum.length; i++) assert.ok(t.cum[i] > t.cum[i - 1], `${id} at ${i}`);
      assert.ok(Math.abs(t.cum[t.cum.length - 1] - 1) < 1e-12);
    }
  }
});

test('paytables are well formed: ascending multipliers, descending weights', () => {
  for (const id of MACHINE_IDS) {
    const m = MACHINES[id];
    assert.equal(m.id, id, 'registry key must match the machine id');
    assert.ok(m.reels >= 3 && m.reels <= 5, `${id}: reel count ${m.reels}`);
    assert.equal(m.mult.length, m.weight.length, `${id}: ladder length mismatch`);
    assert.ok(m.mult.length >= 5, `${id}: too few symbols`);
    for (let i = 1; i < m.mult.length; i++) {
      assert.ok(m.mult[i] > m.mult[i - 1], `${id}: multiplier ${i} does not increase`);
      // A bigger prize must never be more likely than a smaller one.
      assert.ok(m.weight[i] < m.weight[i - 1], `${id}: weight ${i} does not decrease`);
    }
    for (const w of m.weight) assert.ok(w > 0, `${id}: non-positive weight`);
  }
});

test('unknown machine ids fall back to the default, never throw', () => {
  assert.equal(getMachine('nope').id, DEFAULT_MACHINE);
  assert.equal(getMachine(undefined).id, DEFAULT_MACHINE);
  assert.deepEqual(
    spin({ serverSeed: SEED, clientSeed: 'x', nonce: 3, rtp: 0.96, bet: 10, machine: 'nope' }),
    spin({ serverSeed: SEED, clientSeed: 'x', nonce: 3, rtp: 0.96, bet: 10 }),
  );
});

// These cabinets are retired: none of them is on the floor and none can
// be spun. What the engine still owes is exact reproduction of rounds
// recorded while they were playable, which is why every calibration test
// in this file stays. If a future change makes the engine unnecessary,
// the rounds have to be re-verifiable some other way first.
test('no retired machine is reachable from the floor', async () => {
  const floor = await import('../src/games/slot-floor.js');
  for (const id of MACHINE_IDS) {
    assert.ok(!floor.FLOOR_IDS.includes(id), `${id} is retired but still on the floor`);
    assert.equal(floor.isFloorMachine(id), false, id);
  }
  // …but a recorded round still replays on the engine that resolved it.
  assert.equal(floor.kindOf(DEFAULT_MACHINE), 'ladder');
  const replay = floor.spinFloor({
    serverSeed: SEED, clientSeed: 'frozen', nonce: 9, rtp: 0.96, bet: 100, machine: 'classic',
  });
  assert.equal(replay.kind, 'ladder');
  assert.equal(replay.mult, 25);
});

// `classic` decides the outcome of every slots round recorded before
// the floor had more than one machine. Changing a single weight would
// silently break verification for all of them, so its output is pinned.
test('the classic ladder is frozen', () => {
  assert.deepEqual(MULT, [0.5, 1, 2, 5, 10, 25, 100, 500, 2000]);
  assert.deepEqual(WEIGHT, [0.1, 0.08, 0.06, 0.035, 0.015, 0.006, 0.0018, 0.00018, 0.00002]);
  assert.equal(SYMBOL_COUNT, 9);
  assert.equal(DEFAULT_MACHINE, 'classic');

  const expected = [
    [1, [1, 1, 1]], [1, [1, 1, 1]], [0.5, [0, 0, 0]], [0, [2, 8, 4]],
    [0, [8, 1, 8]], [0, [5, 6, 5]], [1, [1, 1, 1]], [0, [2, 3, 7]],
    [0, [5, 6, 1]], [25, [5, 5, 5]], [0.5, [0, 0, 0]], [0, [5, 7, 6]],
  ];
  const actual = expected.map((_, nonce) => {
    const out = spin({ serverSeed: SEED, clientSeed: 'frozen', nonce, rtp: 0.96, bet: 100 });
    return [out.mult, out.reels];
  });
  assert.deepEqual(actual, expected);
});

// One shared draw stream, evaluated against every machine's table. The
// mean tolerance is four standard errors with the standard deviation
// taken from the paytable itself; the hit-rate tolerance is binomial
// and far tighter, and it is the one that breaks when the loss entry
// goes missing from a table (every round becomes a win).
const N = 2_000_000;
const US = new Float64Array(N);
for (let nonce = 0; nonce < N; nonce++) US[nonce] = uniform(SEED, 'empirical', nonce);

test('empirical return over 2,000,000 rounds is within four standard errors', () => {
  for (const rtp of RTPS) {
    const table = buildTable(rtp);
    let total = 0;
    let hits = 0;
    for (let n = 0; n < N; n++) {
      const mult = table.outs[pickIndex(table, US[n])];
      total += mult;
      if (mult > 0) hits++;
    }
    const mean = total / N;
    const se = standardDeviation(rtp) / Math.sqrt(N);
    assert.ok(
      Math.abs(mean - rtp) < 4 * se,
      `rtp ${rtp}: empirical ${mean.toFixed(6)}, |diff| ${Math.abs(mean - rtp).toFixed(6)} vs 4se ${(4 * se).toFixed(6)}`,
    );

    const hitRate = hits / N;
    const seHit = Math.sqrt((table.q * (1 - table.q)) / N);
    assert.ok(
      Math.abs(hitRate - table.q) < 4 * seHit,
      `rtp ${rtp}: hit rate ${hitRate.toFixed(4)} vs q ${table.q.toFixed(4)}`,
    );
  }
});

test('every machine hits at its own calibrated rate', () => {
  const sample = 600_000;
  for (const id of MACHINE_IDS) {
    for (const rtp of RTPS) {
      const table = buildTable(rtp, id);
      let total = 0;
      let hits = 0;
      for (let n = 0; n < sample; n++) {
        const mult = table.outs[pickIndex(table, US[n])];
        total += mult;
        if (mult > 0) hits++;
      }
      const hitRate = hits / sample;
      const seHit = Math.sqrt((table.q * (1 - table.q)) / sample);
      assert.ok(
        Math.abs(hitRate - table.q) < 4 * seHit,
        `${id} at rtp ${rtp}: hit rate ${hitRate.toFixed(5)} vs q ${table.q.toFixed(5)}`,
      );
      const se = standardDeviation(rtp, id) / Math.sqrt(sample);
      assert.ok(
        Math.abs(total / sample - rtp) < 4 * se,
        `${id} at rtp ${rtp}: empirical ${(total / sample).toFixed(5)}`,
      );
    }
  }
});

test('a losing round never renders a full match; a win always does', () => {
  for (const id of MACHINE_IDS) {
    const m = getMachine(id);
    let losses = 0;
    let wins = 0;
    for (let nonce = 0; nonce < 6000; nonce++) {
      const out = spin({ serverSeed: SEED, clientSeed: 'display', nonce, rtp: 0.96, bet: 10, machine: id });
      assert.equal(out.machine, id);
      assert.equal(out.reels.length, m.reels, `${id}: wrong reel count`);
      for (const r of out.reels) {
        assert.ok(Number.isInteger(r) && r >= 0 && r < m.mult.length, `${id}: symbol ${r}`);
      }
      const full = out.reels.every((r) => r === out.reels[0]);
      if (out.mult === 0) {
        losses++;
        assert.ok(!full, `${id}: loss rendered as a win at nonce ${nonce}`);
        assert.equal(out.payout, 0);
      } else {
        wins++;
        assert.ok(full, `${id}: win not rendered as a full match at nonce ${nonce}`);
        assert.equal(out.reels[0], m.mult.indexOf(out.mult));
      }
    }
    assert.ok(losses > 2000 && wins > 200, `${id}: losses ${losses}, wins ${wins}`);
  }
});

test('spins are deterministic for identical seeds, nonce and machine', () => {
  for (const id of MACHINE_IDS) {
    for (let nonce = 0; nonce < 30; nonce++) {
      const a = spin({ serverSeed: SEED, clientSeed: 'det', nonce, rtp: 0.96, bet: 25, machine: id });
      const b = spin({ serverSeed: SEED, clientSeed: 'det', nonce, rtp: 0.96, bet: 25, machine: id });
      assert.deepEqual(a, b);
    }
  }
  // A single outcome can collide across seeds (both may land in the
  // same bucket); a whole sequence must not.
  const seq = (serverSeed) =>
    Array.from({ length: 20 }, (_, nonce) =>
      spin({ serverSeed, clientSeed: 'det', nonce, rtp: 0.96, bet: 25 }),
    );
  assert.notDeepEqual(seq(SEED), seq('e'.repeat(64)));
});

test('payouts are integer credits on every ladder', () => {
  assert.equal(payoutFor(10, 0.5), 5);
  assert.equal(payoutFor(3, 2), 6);
  assert.equal(payoutFor(7, 2000), 14000);
  for (const id of MACHINE_IDS) {
    for (const bet of [1, 2, 3, 500]) {
      for (const mult of getMachine(id).mult) {
        assert.ok(Number.isInteger(payoutFor(bet, mult)), `${id}: ${bet} x ${mult}`);
      }
    }
  }
});

test('reels are reproducible from the recorded index', () => {
  // The verifier recomputes reels from (seeds, nonce, index) alone.
  for (const id of MACHINE_IDS) {
    const m = getMachine(id);
    for (let nonce = 0; nonce < 120; nonce++) {
      const out = spin({ serverSeed: SEED, clientSeed: 'reels', nonce, rtp: 0.96, bet: 5, machine: id });
      const index = out.mult === 0 ? 0 : m.mult.indexOf(out.mult) + 1;
      assert.deepEqual(
        reelsFor({ serverSeed: SEED, clientSeed: 'reels', nonce, index, machine: id }),
        out.reels,
      );
    }
  }
});

test('the machine view reports the real paytable and a derived volatility', () => {
  for (const id of MACHINE_IDS) {
    const m = getMachine(id);
    const view = machineView(id, 0.96);
    assert.equal(view.id, id);
    assert.equal(view.reels, m.reels);
    assert.equal(view.symbols, m.mult.length);
    assert.deepEqual(view.mult, m.mult);
    assert.equal(view.top, m.mult[m.mult.length - 1]);
    assert.equal(view.hit_rate, buildTable(0.96, id).q);
    assert.equal(view.sd, standardDeviation(0.96, id));
    assert.equal(view.volatility, volatilityBand(view.sd));
    assert.ok(['low', 'mid', 'high', 'extreme'].includes(view.volatility));
  }
  // The floor should offer a genuine spread, not six versions of one
  // machine: the calmest and the wildest must be an order apart.
  const sds = MACHINE_IDS.map((id) => standardDeviation(0.96, id));
  assert.ok(Math.max(...sds) / Math.min(...sds) > 10, `sd spread ${sds}`);
});

// slot-themes.js is pure presentation data, so it can be checked here
// rather than in a browser. A theme that is one symbol short of its
// paytable renders the top prize as a "?" — silently, and only for the
// rarest outcome on the machine, which is the worst possible place to
// find a bug by hand.
test('every machine has artwork with one symbol per paytable tier', () => {
  assert.deepEqual(Object.keys(THEMES), MACHINE_IDS, 'theme list must track the registry');
  for (const id of MACHINE_IDS) {
    const look = THEMES[id];
    const m = getMachine(id);
    assert.equal(look.id, id, 'theme key must match its id');
    assert.equal(look.symbols.length, m.mult.length, `${id}: symbol count`);
    assert.equal(new Set(look.symbols).size, look.symbols.length, `${id}: duplicate symbol`);
    assert.ok(look.run > 0 && look.gap > 0, `${id}: reel timing`);
    assert.ok(look.art && look.land, `${id}: missing art or landing style`);
    assert.ok(look.sound.motif.length >= 2, `${id}: result motif too short`);
  }
  // Cabinets should not sound or look like each other.
  assert.equal(new Set(MACHINE_IDS.map((id) => THEMES[id].art)).size, MACHINE_IDS.length);
  assert.equal(new Set(MACHINE_IDS.map((id) => THEMES[id].land)).size, MACHINE_IDS.length);
  // Rounds recorded before the floor existed carry no machine id.
  assert.equal(theme(undefined), FALLBACK_THEME);
  assert.equal(theme('gone'), FALLBACK_THEME);
  assert.equal(FALLBACK_THEME.id, DEFAULT_MACHINE);
});
