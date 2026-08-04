import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LINE_MACHINES,
  LINE_MACHINE_IDS,
  getLineMachine,
  layout,
  buildLines,
  windowFor,
  gridFor,
  stopsFor,
  lineWin,
  evaluateGrid,
  scatterDistribution,
  naturalReturn,
  payScale,
  theoreticalReturn,
  returnStandardDeviation,
  hitRate,
  spinLines,
  lineMachineView,
} from '../src/games/slot-lines.js';
import { volatilityBand } from '../src/games/slots.js';

const SEED = 'e'.repeat(64);
const RTPS = [0.8, 0.9, 0.96, 0.98, 0.99];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── Calibration ────────────────────────────────────────────────── */

// The whole point of the payline engine is that the RTP is solved, not
// sampled. A payline touches exactly one cell per column, and because
// the stop is uniform over the strip that cell is uniform over the strip
// whatever row the line is on — so along a line the columns are
// independent with known marginals, every line has the same EV, and
// linearity of expectation handles the fact that lines overlap.
test('every line machine returns exactly its configured RTP', () => {
  for (const id of LINE_MACHINE_IDS) {
    for (const rtp of RTPS) {
      const er = theoreticalReturn(rtp, id);
      assert.ok(
        Math.abs(er - rtp) < 1e-12,
        `${id} at rtp ${rtp}: expected return ${er}, diff ${Math.abs(er - rtp)}`,
      );
    }
  }
});

// The pay values in the registry are pre-normalised so that at the
// default RTP the scale factor is ~1. That is what lets the paytable on
// screen be the paytable in the source: if this drifts, a player reading
// the registry is no longer reading the numbers they are being paid.
test('the designed paytable is what is paid at the default RTP', () => {
  for (const id of LINE_MACHINE_IDS) {
    const scale = payScale(0.96, id);
    assert.ok(
      Math.abs(scale - 1) < 0.05,
      `${id}: payScale at 0.96 is ${scale}, so the displayed table is off by ${((scale - 1) * 100).toFixed(1)}%`,
    );
  }
});

test('scaling the paytable scales the return by the same factor', () => {
  for (const id of LINE_MACHINE_IDS) {
    const natural = naturalReturn(id);
    for (const rtp of RTPS) {
      assert.ok(Math.abs(payScale(rtp, id) * natural - rtp) < 1e-12, `${id} at ${rtp}`);
    }
  }
});

/* ── Volatility ─────────────────────────────────────────────────── */

// The four cabinets are meant to span the whole scale rather than be one
// machine in four palettes. The sd is computed exactly (see the note in
// slot-lines.js on why sampling it cannot work), so these are stable
// numbers and not seed-dependent — pinning the band is meaningful.
test('the line machines span every volatility band', () => {
  const bands = LINE_MACHINE_IDS.map((id) => volatilityBand(returnStandardDeviation(0.96, id)));
  assert.deepEqual(bands, ['low', 'mid', 'high', 'extreme']);
});

test('each machine sits inside its band with headroom', () => {
  // A machine parked on a boundary would flip band on any future tweak.
  const edges = [4, 10, 20];
  for (const id of LINE_MACHINE_IDS) {
    const sd = returnStandardDeviation(0.96, id);
    for (const edge of edges) {
      assert.ok(
        Math.abs(sd - edge) > 0.5,
        `${id}: sd ${sd.toFixed(2)} sits on the ${edge} band boundary`,
      );
    }
  }
});

test('volatility is a property of the paytable shape, not the RTP', () => {
  // Scaling every pay by one factor scales the sd by that same factor,
  // so the ordering of the floor must not move when an admin changes the
  // RTP. A player picking "the wild one" gets the wild one at any RTP.
  const order = (rtp) =>
    [...LINE_MACHINE_IDS].sort(
      (a, b) => returnStandardDeviation(rtp, a) - returnStandardDeviation(rtp, b),
    );
  assert.deepEqual(order(0.8), order(0.96));
  assert.deepEqual(order(0.99), order(0.96));
});

/* ── The wild-on-reel-0 invariant ───────────────────────────────── */

// This is the load-bearing structural rule. Wilds are kept off reel 0 so
// the top prize is not cheap to reach; the consequence is that a win
// always starts on reel 0 with a real symbol, so the symbol in column 0
// uniquely owns the line. That is what makes the line return separable
// per symbol, and it also means the wild can never form a combination of
// its own — so advertising a pay for it would be advertising a prize
// that cannot be won.
test('no machine puts a wild on reel 0', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    assert.ok(!m.strips[0].includes(m.wild), `${id} has a wild on reel 0`);
  }
});

test('the wild and scatter advertise no line pay of their own', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    assert.deepEqual(m.pay[m.wild], [0, 0, 0], `${id} wild`);
    assert.deepEqual(m.pay[m.scatter], [0, 0, 0], `${id} scatter`);
  }
});

test('wilds substitute for the symbol that opened the line', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    for (let sym = 0; sym < m.symbols.length; sym++) {
      if (sym === m.wild || sym === m.scatter) continue;
      const cells = [sym, ...new Array(m.cols - 1).fill(m.wild)];
      const win = lineWin(cells, m);
      assert.equal(win.run, m.cols, `${id} symbol ${sym}: wilds did not extend the run`);
      assert.equal(win.symbol, sym, `${id} symbol ${sym}: wrong symbol credited`);
      assert.equal(win.pay, m.pay[sym][m.cols - 3], `${id} symbol ${sym}: wrong pay`);
    }
  }
});

// A line of nothing but wilds cannot happen — reel 0 never holds one —
// so this only pins the resolution rule rather than a reachable outcome.
// Were it reachable it would score as the best symbol the wilds stand in
// for, which is the usual behaviour, and never as the wild itself.
test('a hypothetical all-wild line resolves to the best substituted symbol', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    const win = lineWin(new Array(m.cols).fill(m.wild), m);
    const best = Math.max(
      ...m.pay.map((row, s) => (s === m.scatter ? 0 : row[m.cols - 3])),
    );
    assert.equal(win.pay, best, `${id}: all wilds should pay the best line`);
    assert.notEqual(win.symbol, m.wild, `${id}: credited to the wild's own empty row`);
  }
});

/* ── Reel strips and paylines ───────────────────────────────────── */

test('layout places exactly the requested count of every symbol', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    m.counts.forEach((counts, reel) => {
      const strip = m.strips[reel];
      assert.equal(strip.length, counts.reduce((a, b) => a + b, 0), `${id} reel ${reel} length`);
      counts.forEach((want, sym) => {
        const got = strip.filter((s) => s === sym).length;
        assert.equal(got, want, `${id} reel ${reel} symbol ${sym}`);
      });
    });
  }
});

// Symbols are spread rather than clumped, so a reel does not contain a
// solid block of one symbol that would land three of it in one column.
test('layout spreads symbols instead of clumping them', () => {
  const strip = layout([10, 5, 5]);
  let longestRun = 1;
  let run = 1;
  for (let i = 1; i < strip.length; i++) {
    run = strip[i] === strip[i - 1] ? run + 1 : 1;
    if (run > longestRun) longestRun = run;
  }
  assert.ok(longestRun <= 2, `longest run of one symbol was ${longestRun}`);
});

test('paylines are distinct, full width and vertically connected', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    assert.equal(m.lines.length, m.lineCount, `${id} line count`);
    const seen = new Set();
    for (const line of m.lines) {
      assert.equal(line.length, m.cols, `${id}: line is not full width`);
      assert.ok(line.every((r) => r >= 0 && r < m.rows), `${id}: line leaves the grid`);
      for (let i = 1; i < line.length; i++) {
        assert.ok(Math.abs(line[i] - line[i - 1]) <= 1, `${id}: line jumps a row`);
      }
      const key = line.join(',');
      assert.ok(!seen.has(key), `${id}: duplicate line ${key}`);
      seen.add(key);
    }
  }
});

test('the straight rows come first, so line 1 is the middle-ish row', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    for (let r = 0; r < m.rows; r++) {
      assert.ok(m.lines[r].every((x) => x === r), `${id}: line ${r} is not the flat row ${r}`);
    }
  }
});

test('buildLines refuses to invent more lines than the grid has', () => {
  assert.throws(() => buildLines(3, 5, 100), /only 99 connected lines/);
  assert.doesNotThrow(() => buildLines(3, 5, 99));
  assert.doesNotThrow(() => buildLines(4, 5, 178));
});

/* ── Grid construction ──────────────────────────────────────────── */

test('the window wraps around the end of a strip', () => {
  const strip = [0, 1, 2, 3, 4];
  assert.deepEqual(windowFor(strip, 0, 3), [0, 1, 2]);
  assert.deepEqual(windowFor(strip, 3, 3), [3, 4, 0]);
  assert.deepEqual(windowFor(strip, 4, 3), [4, 0, 1]);
});

test('every stop is a valid index into its own reel', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    for (let nonce = 0; nonce < 200; nonce++) {
      const stops = stopsFor({ serverSeed: SEED, clientSeed: 'grid', nonce, machine: m });
      assert.equal(stops.length, m.cols);
      stops.forEach((s, c) => {
        assert.ok(Number.isInteger(s) && s >= 0 && s < m.strips[c].length, `${id} reel ${c}`);
      });
    }
  }
});

test('the grid is column-major and matches the strips at the stops', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    const stops = stopsFor({ serverSeed: SEED, clientSeed: 'grid', nonce: 7, machine: m });
    const grid = gridFor(stops, m);
    assert.equal(grid.length, m.cols);
    grid.forEach((col, c) => {
      assert.equal(col.length, m.rows);
      col.forEach((sym, r) => {
        assert.equal(sym, m.strips[c][(stops[c] + r) % m.strips[c].length], `${id} ${c},${r}`);
      });
    });
  }
});

/* ── Line evaluation ────────────────────────────────────────────── */

test('a win must start on reel 0 — matches further right do not pay', () => {
  const m = getLineMachine('vault');
  const sym = 0;
  const other = 1;
  assert.ok(lineWin([sym, sym, sym, other, other], m).pay > 0, 'left aligned pays');
  assert.equal(lineWin([other, sym, sym, sym, other], m).pay, 0, 'floating run pays nothing');
  assert.equal(lineWin([other, other, sym, sym, sym], m).pay, 0, 'right aligned pays nothing');
});

test('runs shorter than three pay nothing', () => {
  const m = getLineMachine('vault');
  assert.equal(lineWin([0, 0, 1, 1, 1], m).pay, 0);
});

test('a longer run of the same symbol never pays less than a shorter one', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    for (let s = 0; s < m.symbols.length; s++) {
      if (s === m.wild || s === m.scatter) continue;
      assert.ok(m.pay[s][1] >= m.pay[s][0], `${id} symbol ${s}: 4 pays less than 3`);
      assert.ok(m.pay[s][2] >= m.pay[s][1], `${id} symbol ${s}: 5 pays less than 4`);
    }
  }
});

test('evaluateGrid totals the winning lines and reports where they are', () => {
  const m = getLineMachine('vault');
  // Force a five-of-a-kind of symbol 0 along the top row.
  const grid = Array.from({ length: m.cols }, () => new Array(m.rows).fill(1));
  for (let c = 0; c < m.cols; c++) grid[c][0] = 0;
  const out = evaluateGrid(grid, m);
  const top = out.wins.find((w) => w.line === 0);
  assert.ok(top, 'the flat top row should win');
  assert.equal(top.symbol, 0);
  assert.equal(top.run, m.cols);
  assert.equal(top.pay, m.pay[0][m.cols - 3]);
  assert.ok(out.total >= top.pay);
});

test('scatters pay from anywhere on the grid, not along a line', () => {
  const m = getLineMachine('vault');
  const blank = () => {
    // symbol 1 everywhere, with no three-in-a-row starting at reel 0
    const g = Array.from({ length: m.cols }, () => new Array(m.rows).fill(1));
    for (let r = 0; r < m.rows; r++) g[0][r] = 0;
    for (let r = 0; r < m.rows; r++) g[1][r] = 2;
    return g;
  };
  // three scatters, deliberately scattered across different rows
  const g = blank();
  g[0][0] = m.scatter;
  g[2][1] = m.scatter;
  g[4][2] = m.scatter;
  const out = evaluateGrid(g, m);
  assert.equal(out.scatterCells.length, 3);
  assert.equal(out.scatterPay, m.scatterPay[0]);

  // the same three scatters stacked in one column pay the same
  const h = blank();
  h[2][0] = m.scatter;
  h[2][1] = m.scatter;
  h[2][2] = m.scatter;
  assert.equal(evaluateGrid(h, m).scatterPay, m.scatterPay[0]);
});

test('the scatter distribution is a probability distribution', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    const dist = scatterDistribution(m);
    const sum = dist.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-12, `${id}: scatter distribution sums to ${sum}`);
    assert.ok(dist.every((p) => p >= 0), `${id}: negative probability`);
    assert.ok(dist.length - 1 <= m.cols * m.rows, `${id}: more scatters than cells`);
  }
});

/* ── Spins ──────────────────────────────────────────────────────── */

test('a spin is reproducible from its seeds and nonce', () => {
  for (const id of LINE_MACHINE_IDS) {
    for (let nonce = 0; nonce < 20; nonce++) {
      const args = { serverSeed: SEED, clientSeed: 'again', nonce, rtp: 0.96, bet: 100, machine: id };
      assert.deepEqual(spinLines(args), spinLines(args), `${id} nonce ${nonce}`);
    }
  }
});

test('the payout is the multiplier applied to the whole bet', () => {
  for (const id of LINE_MACHINE_IDS) {
    for (let nonce = 0; nonce < 100; nonce++) {
      const out = spinLines({
        serverSeed: SEED, clientSeed: 'pay', nonce, rtp: 0.96, bet: 137, machine: id,
      });
      assert.equal(out.payout, Math.round(137 * out.mult), `${id} nonce ${nonce}`);
      assert.ok(out.mult >= 0, `${id}: negative multiplier`);
      assert.equal(out.kind, 'lines');
      assert.equal(out.machine, id);
    }
  }
});

test('a spin reports only the lines that actually won', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    for (let nonce = 0; nonce < 300; nonce++) {
      const out = spinLines({
        serverSeed: SEED, clientSeed: 'wins', nonce, rtp: 0.96, bet: 20, machine: id,
      });
      for (const w of out.wins) {
        assert.ok(w.pay > 0, `${id}: a reported win pays nothing`);
        assert.ok(w.run >= 3 && w.run <= m.cols, `${id}: impossible run ${w.run}`);
        assert.notEqual(w.symbol, m.scatter, `${id}: scatter reported as a line win`);
        // the cells it claims really do hold that symbol or a wild
        const line = m.lines[w.line];
        for (let c = 0; c < w.run; c++) {
          const cell = out.grid[c][line[c]];
          assert.ok(cell === w.symbol || cell === m.wild, `${id}: win cell ${c} does not match`);
        }
      }
      if (out.wins.length === 0 && out.scatterCells.length < 3) {
        assert.equal(out.mult, 0, `${id}: paid with nothing on the grid`);
      }
    }
  }
});

// A losing spin has to look like a losing spin. The ladder engine needs
// an explicit guard for this; here it is structural, because the grid is
// generated before anything is evaluated and the win is read off it.
test('a zero multiplier means nothing on the grid won', () => {
  for (const id of LINE_MACHINE_IDS) {
    for (let nonce = 0; nonce < 300; nonce++) {
      const out = spinLines({
        serverSeed: SEED, clientSeed: 'loss', nonce, rtp: 0.96, bet: 20, machine: id,
      });
      if (out.mult === 0) {
        assert.equal(out.wins.length, 0, `${id}: a losing spin listed a win`);
        assert.equal(out.scatterPay, 0, `${id}: a losing spin paid a scatter`);
      }
    }
  }
});

/* ── The analytic model against the real evaluator ──────────────── */

// The RTP above is solved from the marginals. This runs the actual
// evaluation path over a large sample and checks the two agree — it is
// what would catch the solved model and the code that pays players
// drifting apart.
function splitmix32(a) {
  return () => {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

test('simulated play converges on the solved RTP', () => {
  const N = 300000;
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    const scale = payScale(0.96, id);
    const rnd = splitmix32(0x5eed ^ (id.length * 7919));
    const stops = new Array(m.cols);
    let sum = 0;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      for (let c = 0; c < m.cols; c++) stops[c] = Math.floor(rnd() * m.strips[c].length);
      const mult = (evaluateGrid(gridFor(stops, m), m).total / m.lines.length) * scale;
      sum += mult;
      if (mult > 0) hits++;
    }
    // The exact sd is a lower bound (it assumes lines are independent,
    // and overlapping lines are positively correlated), so allow a
    // generous multiple of the implied standard error rather than a flat
    // percentage — the extreme machine is far noisier than the calm one.
    const se = returnStandardDeviation(0.96, id) / Math.sqrt(N);
    const err = Math.abs(sum / N - 0.96);
    assert.ok(err < 6 * se + 0.005, `${id}: simulated ${(sum / N).toFixed(4)} vs 0.96 (se ${se.toFixed(4)})`);
    assert.ok(
      Math.abs(hits / N - hitRate(id)) < 0.01,
      `${id}: simulated hit rate ${(hits / N).toFixed(4)} vs reported ${hitRate(id).toFixed(4)}`,
    );
  }
});

/* ── What the client is told ────────────────────────────────────── */

test('the machine view exposes the scaled paytable and nothing extra', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    const view = lineMachineView(id, 0.96);
    const scale = payScale(0.96, id);
    assert.equal(view.id, id);
    assert.equal(view.kind, 'lines');
    assert.equal(view.rows, m.rows);
    assert.equal(view.cols, m.cols);
    assert.deepEqual(view.symbols, m.symbols);
    view.pay.forEach((row, s) => {
      row.forEach((v, r) => assert.ok(Math.abs(v - m.pay[s][r] * scale) < 1e-9, `${id} pay ${s},${r}`));
    });
    // The reel strips are not shipped: they are the machine's par sheet,
    // and a player verifying a round rebuilds them from the registry the
    // verifier already carries.
    assert.equal(view.strips, undefined, `${id} leaks its reel strips`);
    assert.equal(view.counts, undefined, `${id} leaks its reel composition`);
  }
});

/* ── Artwork ────────────────────────────────────────────────────── */

// A typo in a symbol key renders as a broken image on the reels, which
// no unit test of the maths would ever catch.
test('every symbol key names an image that exists', () => {
  const dir = path.join(ROOT, 'public', 'assets', 'symbols');
  for (const id of LINE_MACHINE_IDS) {
    for (const key of getLineMachine(id).symbols) {
      const file = path.join(dir, `gem-${key}.png`);
      assert.ok(fs.existsSync(file), `${id}: missing artwork for ${key} (${file})`);
    }
  }
});

test('the artwork credits every pack it ships', () => {
  const credits = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'symbols', 'CREDITS.md'), 'utf8');
  assert.match(credits, /CC0/, 'the licence must be stated');
  assert.match(credits, /opengameart\.org/, 'the source must be linked');
});

/* ── Registry hygiene ───────────────────────────────────────────── */

test('the registry is internally consistent', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = getLineMachine(id);
    assert.equal(m.id, id, 'the key and the id must agree');
    assert.equal(m.kind, 'lines');
    assert.equal(m.pay.length, m.symbols.length, `${id}: a symbol has no pay row`);
    assert.equal(m.counts.length, m.cols, `${id}: wrong number of reels`);
    for (const counts of m.counts) {
      assert.equal(counts.length, m.symbols.length, `${id}: a reel is missing a symbol`);
    }
    assert.equal(m.scatterPay.length, 3, `${id}: scatter pays 3, 4 and 5`);
    assert.notEqual(m.wild, m.scatter, `${id}: wild and scatter must differ`);
    assert.equal(new Set(m.symbols).size, m.symbols.length, `${id}: duplicate symbol key`);
  }
});

test('line machine ids do not collide with ladder machine ids', async () => {
  const ladder = await import('../src/games/slots.js');
  for (const id of LINE_MACHINE_IDS) {
    assert.ok(!ladder.MACHINE_IDS.includes(id), `${id} exists on both engines`);
  }
});

test('an unknown id is not silently resolved to a real machine', () => {
  assert.equal(getLineMachine('not-a-machine'), undefined);
  assert.equal(LINE_MACHINES['not-a-machine'], undefined);
});
