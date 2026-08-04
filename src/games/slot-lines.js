import { uniform } from '../rng.js';

// Payline slot engine: a real reel-strip machine, not a multiplier
// ladder. Each column has a strip of symbols, one uniform draw per
// column picks that reel's stop, and the visible window is `rows`
// consecutive strip entries (wrapping). Wins are read left to right
// along fixed paylines, a wild substitutes for anything but the
// scatter, and the scatter pays wherever it lands.
//
// This engine lives beside the ladder engine in `slots.js` rather than
// replacing it. Ladder rounds already recorded must keep verifying, and
// their cursor layout is different, so the two coexist and every
// machine declares its `kind`.
//
// ── Why the RTP can still be exact ──────────────────────────────────
//
// It looks like the correlation between cells in a column would make
// the expected return intractable. It does not, because of one fact:
// a payline touches exactly one cell per column, and for a fixed row
// that cell is strip[c][(stop + row) mod len]. As `stop` is uniform
// over the strip, the symbol on that cell is uniform over the strip —
// whatever the row. So along any single line the columns are
// independent with known marginals, and every line has the identical
// expected value. Linearity of expectation then handles the fact that
// different lines overlap:
//
//     E[total line win] = lineCount * E[one line]
//
// E[one line] is computed by exhaustive enumeration over symbol tuples
// (a few hundred thousand at most), so it is exact rather than
// sampled. The scatter is handled separately because it reads the
// whole window: the per-column distribution of visible scatters is
// found by walking every stop position, and those are independent
// across columns, so convolving them gives the exact distribution.
//
// Both parts are linear in the pay values, so the whole paytable is
// scaled by a single factor to land on the configured RTP exactly.

/* ── Strip construction ─────────────────────────────────────────── */

/**
 * Lay out a reel strip from per-symbol counts, spreading each symbol as
 * evenly as the counts allow (largest-remainder, the same idea as
 * Bresenham). Even spacing is deliberate: it keeps two scatters from
 * sitting next to each other on the strip, which would otherwise make
 * the "two in one column" case far more likely than it looks.
 *
 * Deterministic — no RNG anywhere in strip construction.
 */
export function layout(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const placed = counts.map(() => 0);
  const strip = [];
  for (let i = 0; i < total; i++) {
    let best = -1;
    let bestDeficit = -Infinity;
    for (let s = 0; s < counts.length; s++) {
      if (placed[s] >= counts[s]) continue;
      // How far behind its fair share this symbol has fallen.
      const deficit = (i + 1) * (counts[s] / total) - placed[s];
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = s;
      }
    }
    strip.push(best);
    placed[best]++;
  }
  return strip;
}

/* ── Payline geometry ───────────────────────────────────────────── */

/**
 * The canonical payline set for a grid. A payline is one row index per
 * column where neighbouring columns differ by at most one row, so every
 * line is a connected path a player can actually trace with a finger.
 *
 * Ordering is fixed and meaningful: the flat rows come first, then
 * lines are sorted by how much they move vertically, then
 * lexicographically. That way a 10-line machine gets the ten calmest
 * shapes and a 30-line machine gets those ten plus the next twenty.
 *
 * The order is part of the paytable — it decides which lines exist on a
 * machine and therefore its payout — so `test/slot-lines.test.js` pins
 * the generated output. Changing this function changes outcomes.
 */
export function buildLines(rows, cols, count) {
  const paths = [];
  const walk = (path) => {
    if (path.length === cols) {
      paths.push(path.slice());
      return;
    }
    const last = path[path.length - 1];
    for (let r = 0; r < rows; r++) {
      if (path.length === 0 || Math.abs(r - last) <= 1) {
        path.push(r);
        walk(path);
        path.pop();
      }
    }
  };
  walk([]);

  const travel = (p) => p.reduce((a, r, i) => (i ? a + Math.abs(r - p[i - 1]) : 0), 0);
  const flat = (p) => (p.every((r) => r === p[0]) ? 0 : 1);
  paths.sort((a, b) => {
    if (flat(a) !== flat(b)) return flat(a) - flat(b);
    if (flat(a) === 0) return a[0] - b[0];
    if (travel(a) !== travel(b)) return travel(a) - travel(b);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });

  if (count > paths.length) {
    throw new Error(`only ${paths.length} connected lines exist on ${rows}x${cols}`);
  }
  return paths.slice(0, count);
}

/* ── Machine registry ───────────────────────────────────────────── */

// Symbol keys name an image in public/assets/symbols. The shape encodes
// the pay tier on purpose — squares are the cheap symbols, octagons are
// mid, the diamond is the top symbol, triangles carry wild and scatter
// — so the grid is readable without consulting the paytable.

function machine(spec) {
  const symbols = spec.symbols.map((s) => s.key);
  const strips = spec.counts.map((c) => layout(c));
  const lines = buildLines(spec.rows, spec.cols, spec.lineCount);
  return { kind: 'lines', ...spec, symbols, strips, lines };
}

// Every counts row is one reel; every column of that row is one symbol,
// in the same order as `symbols`. Every machine keeps the wild off reel
// 0, which is the usual way to stop the top prize being reachable too
// cheaply. A consequence worth stating: a win has to start on reel 0, so
// a run of leading wilds can never happen and the wild can never form a
// combination of its own. Its pay row is therefore all zeros rather than
// a prize the paytable advertises but nobody can win.
//
// That same rule is what makes the calibration below tractable. With no
// wild on reel 0 the symbol in column 0 always owns the line, so
// P(symbol, run length) is fixed by the reel counts alone and the line
// return is linear and separable in the pay values — each row can be
// solved for independently against a target share of the return.
//
// Pay values are multiples of the *line* bet and are calibrated so that
// at the default RTP of 0.96 the scale factor is within about 1% of 1 —
// that is, the numbers written here are the numbers a player sees.
// Moving the RTP away from 0.96 rescales the whole table uniformly.
//
// The four machines are spread deliberately across the whole volatility
// scale — meadow low, vault mid, ember high, monolith extreme — so the
// floor offers genuinely different experiences rather than one feel in
// four palettes.
export const LINE_MACHINES = {
  // Calm: pays on about 45% of spins and tops out near 23x the total
  // bet. The friendliest thing on the floor.
  meadow: machine({
    id: 'meadow',
    rows: 3,
    cols: 5,
    lineCount: 20,
    symbols: [
      { key: 'square-blue', tier: 'low' },
      { key: 'square-green', tier: 'low' },
      { key: 'square-yellow', tier: 'low' },
      { key: 'octagon-green', tier: 'mid' },
      { key: 'octagon-blue', tier: 'mid' },
      { key: 'diamond-green', tier: 'high' },
      { key: 'triangle-yellow', tier: 'wild' },
      { key: 'triangle-purple', tier: 'scatter' },
    ],
    wild: 6,
    scatter: 7,
    pay: [
      [5, 20, 55],
      [6, 25, 65],
      [8, 25, 75],
      [15, 50, 160],
      [20, 65, 250],
      [35, 120, 450],
      [0, 0, 0], // wild substitutes only
      [0, 0, 0], // scatter pays from `scatterPay`
    ],
    scatterPay: [2, 6, 20],
    counts: [
      [11, 10, 10, 4, 3, 2, 0, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
    ],
  }),

  // Steady: three mid symbols give the paytable a real middle, so the
  // gap between a small win and the 889x top prize is filled in.
  vault: machine({
    id: 'vault',
    rows: 3,
    cols: 5,
    lineCount: 20,
    symbols: [
      { key: 'square-purple', tier: 'low' },
      { key: 'square-blue', tier: 'low' },
      { key: 'square-black', tier: 'low' },
      { key: 'octagon-purple', tier: 'mid' },
      { key: 'octagon-red', tier: 'mid' },
      { key: 'octagon-yellow', tier: 'mid' },
      { key: 'diamond-purple', tier: 'high' },
      { key: 'triangle-yellow', tier: 'wild' },
      { key: 'triangle-blue', tier: 'scatter' },
    ],
    wild: 7,
    scatter: 8,
    pay: [
      [5, 20, 70],
      [5, 20, 70],
      [5, 25, 95],
      [20, 95, 480],
      [30, 140, 720],
      [40, 200, 1200],
      [390, 2200, 18000],
      [0, 0, 0], // wild substitutes only
      [0, 0, 0], // scatter pays from `scatterPay`
    ],
    scatterPay: [4, 16, 100],
    counts: [
      [10, 10, 9, 6, 5, 4, 2, 0, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
    ],
  }),

  // Swingy: the cheap symbols do not pay at three at all, so wins land
  // on only a quarter of spins but are worth having when they do. Over
  // a quarter of the return sits on the single top symbol.
  ember: machine({
    id: 'ember',
    rows: 3,
    cols: 5,
    lineCount: 20,
    symbols: [
      { key: 'square-red', tier: 'low' },
      { key: 'square-yellow', tier: 'low' },
      { key: 'square-black', tier: 'low' },
      { key: 'octagon-red', tier: 'mid' },
      { key: 'octagon-yellow', tier: 'mid' },
      { key: 'diamond-red', tier: 'high' },
      { key: 'triangle-yellow', tier: 'wild' },
      { key: 'triangle-green', tier: 'scatter' },
    ],
    wild: 6,
    scatter: 7,
    pay: [
      [0, 10, 55],
      [0, 15, 65],
      [0, 20, 85],
      [20, 110, 700],
      [40, 220, 1500],
      [2800, 18000, 140000],
      [0, 0, 0], // wild substitutes only
      [0, 0, 0], // scatter pays from `scatterPay`
    ],
    scatterPay: [4, 22, 190],
    counts: [
      [14, 13, 12, 6, 4, 1, 0, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
    ],
  }),

  // Wild: four rows, thirty lines, two high symbols and the deepest tail
  // on the floor at roughly 12,800x. Spreading the stake over thirty
  // lines damps the variance, so the top symbol has to carry a much
  // larger share of the return than anywhere else to earn the band.
  monolith: machine({
    id: 'monolith',
    rows: 4,
    cols: 5,
    lineCount: 30,
    symbols: [
      { key: 'square-black', tier: 'low' },
      { key: 'square-blue', tier: 'low' },
      { key: 'square-green', tier: 'low' },
      { key: 'octagon-black', tier: 'mid' },
      { key: 'octagon-blue', tier: 'mid' },
      { key: 'diamond-blue', tier: 'high' },
      { key: 'diamond-yellow', tier: 'high' },
      { key: 'triangle-yellow', tier: 'wild' },
      { key: 'triangle-red', tier: 'scatter' },
    ],
    wild: 7,
    scatter: 8,
    pay: [
      [0, 5, 35],
      [0, 8, 40],
      [0, 10, 55],
      [25, 180, 1100],
      [55, 390, 2900],
      [2500, 18000, 140000],
      [6200, 50000, 385000],
      [0, 0, 0], // wild substitutes only
      [0, 0, 0], // scatter pays from `scatterPay`
    ],
    scatterPay: [3, 18, 200],
    counts: [
      [17, 16, 15, 6, 4, 1, 1, 0, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
    ],
  }),
};

export const LINE_MACHINE_IDS = Object.keys(LINE_MACHINES);

export function getLineMachine(id) {
  return LINE_MACHINES[id];
}

/* ── Grid and evaluation ────────────────────────────────────────── */

/** The visible window on one reel, given its stop position. */
export function windowFor(strip, stop, rows) {
  return Array.from({ length: rows }, (_, r) => strip[(stop + r) % strip.length]);
}

/**
 * Reel stops for a spin: one uniform draw per column, cursors 0..cols-1.
 */
export function stopsFor({ serverSeed, clientSeed, nonce, machine }) {
  return machine.strips.map((strip, c) =>
    Math.floor(uniform(serverSeed, clientSeed, nonce, c) * strip.length),
  );
}

/** Grid as columns of symbol indices: grid[col][row]. */
export function gridFor(stops, machine) {
  return machine.strips.map((strip, c) => windowFor(strip, stops[c], machine.rows));
}

/**
 * Best win on one line, in units of the line bet, plus the symbol and
 * run length that produced it. `cells` is one symbol index per column.
 *
 * A run is a leading, unbroken sequence of "this symbol or a wild".
 * Taking the maximum over every candidate symbol is what decides a line
 * that could be read more than one way — a wild-heavy line is credited
 * to whichever symbol it pays the most as. The wild's own row is all
 * zeros (it never lands on reel 0, so it cannot open a line), so it can
 * win the comparison only when nothing else does, which pays nothing.
 */
export function lineWin(cells, machine) {
  let bestPay = 0;
  let bestSymbol = -1;
  let bestRun = 0;
  for (let s = 0; s < machine.symbols.length; s++) {
    if (s === machine.scatter) continue; // scatters never pay on a line
    let run = 0;
    while (run < cells.length && (cells[run] === s || cells[run] === machine.wild)) run++;
    if (run < 3) continue;
    const pay = machine.pay[s][run - 3];
    if (pay > bestPay) {
      bestPay = pay;
      bestSymbol = s;
      bestRun = run;
    }
  }
  return { pay: bestPay, symbol: bestSymbol, run: bestRun };
}

/**
 * Evaluate a whole grid. Line pays are multiples of the line bet;
 * the scatter pays a multiple of the total bet, so it is converted to
 * line-bet units here to keep one currency throughout.
 */
export function evaluateGrid(grid, machine) {
  const wins = [];
  for (let i = 0; i < machine.lines.length; i++) {
    const cells = machine.lines[i].map((row, col) => grid[col][row]);
    const w = lineWin(cells, machine);
    if (w.pay > 0) wins.push({ line: i, symbol: w.symbol, run: w.run, pay: w.pay });
  }

  const scatterCells = [];
  for (let c = 0; c < grid.length; c++) {
    for (let r = 0; r < grid[c].length; r++) {
      if (grid[c][r] === machine.scatter) scatterCells.push([c, r]);
    }
  }
  const n = scatterCells.length;
  const scatterPay = n >= 3 ? machine.scatterPay[Math.min(n, 5) - 3] : 0;

  const lineTotal = wins.reduce((a, w) => a + w.pay, 0);
  return {
    wins,
    scatterCells,
    scatterPay,
    // total in line-bet units: scatter pays on total bet = lineCount line bets
    total: lineTotal + scatterPay * machine.lines.length,
  };
}

/* ── Exact expected return ──────────────────────────────────────── */

/** Marginal probability of each symbol on each reel. */
function marginals(machine) {
  return machine.strips.map((strip) => {
    const p = machine.symbols.map(() => 0);
    for (const s of strip) p[s]++;
    return p.map((c) => c / strip.length);
  });
}

/**
 * Exact first and second moments of the win on a single line, in
 * line-bet units, by walking every symbol tuple. The alphabet is small
 * and the grid is five wide, so this is a few hundred thousand leaves —
 * cheap enough to do exactly rather than sample, and the first moment
 * is what the RTP is pinned against.
 */
export function lineMoments(machine) {
  const p = marginals(machine);
  const cells = new Array(machine.cols);
  let e1 = 0;
  let e2 = 0;
  const walk = (c, prob) => {
    if (prob === 0) return;
    if (c === machine.cols) {
      const w = lineWin(cells, machine);
      if (w.pay > 0) {
        e1 += prob * w.pay;
        e2 += prob * w.pay * w.pay;
      }
      return;
    }
    for (let s = 0; s < machine.symbols.length; s++) {
      if (p[c][s] === 0) continue;
      cells[c] = s;
      walk(c + 1, prob * p[c][s]);
    }
  };
  walk(0, 1);
  return { e1, e2 };
}

/** Exact expected win on a single line, in line-bet units. */
export function expectedLineWin(machine) {
  return lineMoments(machine).e1;
}

/**
 * Exact distribution of the number of visible scatters. Within a column
 * the cells are adjacent strip entries and so are correlated — that is
 * handled by walking every stop position of that reel. Across columns
 * the stops are independent, so the per-column distributions convolve.
 */
export function scatterDistribution(machine) {
  let dist = [1];
  for (const strip of machine.strips) {
    const per = [];
    for (let stop = 0; stop < strip.length; stop++) {
      let k = 0;
      for (let r = 0; r < machine.rows; r++) {
        if (strip[(stop + r) % strip.length] === machine.scatter) k++;
      }
      per[k] = (per[k] || 0) + 1 / strip.length;
    }
    const next = new Array(dist.length + per.length - 1).fill(0);
    for (let a = 0; a < dist.length; a++) {
      if (!dist[a]) continue;
      for (let b = 0; b < per.length; b++) {
        if (!per[b]) continue;
        next[a + b] += dist[a] * per[b];
      }
    }
    dist = next;
  }
  return dist;
}

/** Exact first and second moments of the scatter win, per total bet. */
export function scatterMoments(machine) {
  const dist = scatterDistribution(machine);
  let e1 = 0;
  let e2 = 0;
  for (let k = 3; k < dist.length; k++) {
    if (!dist[k]) continue;
    const v = machine.scatterPay[Math.min(k, 5) - 3];
    e1 += dist[k] * v;
    e2 += dist[k] * v * v;
  }
  return { e1, e2 };
}

/** Exact expected scatter win, in units of the total bet. */
export function expectedScatterWin(machine) {
  return scatterMoments(machine).e1;
}

// Enumeration is independent of RTP — scaling the paytable scales the
// expected return by exactly the same factor — so it is done once per
// machine and cached.
const naturalCache = new Map();

/**
 * Expected return of a machine at its designed pay values, as a
 * fraction of the total bet. Line wins are per line bet and there are
 * `lineCount` of them against a total bet of `lineCount` line bets, so
 * the line term needs no scaling by the line count at all.
 */
export function naturalReturn(machineId) {
  if (naturalCache.has(machineId)) return naturalCache.get(machineId);
  const m = getLineMachine(machineId);
  const value = expectedLineWin(m) + expectedScatterWin(m);
  naturalCache.set(machineId, value);
  return value;
}

/** Factor applied to every pay value so the machine returns `rtp`. */
export function payScale(rtp, machineId) {
  return rtp / naturalReturn(machineId);
}

/** Exact expected return at a configured RTP — must equal `rtp`. */
export function theoreticalReturn(rtp, machineId) {
  return naturalReturn(machineId) * payScale(rtp, machineId);
}

/**
 * Standard deviation of the return, as a fraction of the total bet.
 *
 * The exact variance would need the joint distribution across
 * overlapping paylines, which does not factorise the way the mean does.
 * Sampling it is not an option either: the top combination has a
 * probability around 1e-6 and pays thousands of times the stake, so
 * whether it happens to fall inside a sample of a few hundred thousand
 * spins moves the answer by more than the width of a volatility band —
 * measured across four seeds, one machine ranged from 11.0 to 19.6.
 *
 * So this is computed exactly under the assumption that lines are
 * independent:
 *
 *     Var ~= Var(one line) / lineCount + Var(scatter)
 *
 * Overlapping lines are positively correlated, so this is a *lower
 * bound* on the true figure rather than an estimate of it. That is a
 * fair trade: it is exact, identical on every run, free to compute, and
 * it orders the machines correctly, which is all the volatility badge
 * needs. It never touches a payout.
 */
export function returnStandardDeviation(rtp, machineId) {
  const m = getLineMachine(machineId);
  const line = lineMoments(m);
  const scat = scatterMoments(m);
  const varLine = Math.max(0, line.e2 - line.e1 * line.e1);
  const varScatter = Math.max(0, scat.e2 - scat.e1 * scat.e1);
  const variance = varLine / m.lines.length + varScatter;
  return Math.sqrt(variance) * payScale(rtp, machineId);
}

/**
 * Probability that a spin returns anything at all.
 *
 * This one is sampled, and unlike the variance it is well behaved: a
 * hit rate is a bounded probability rather than a tail-weighted sum, so
 * 400k draws pin it to within about a tenth of a percentage point. The
 * draw comes from a fixed seed, never Math.random, so the number is
 * identical on every run and can be pinned in tests. It is a display
 * figure only — no payout depends on it.
 */
function sampler(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}

const hitCache = new Map();

export function hitRate(machineId) {
  if (hitCache.has(machineId)) return hitCache.get(machineId);
  const m = getLineMachine(machineId);
  const rnd = sampler(0x51071);
  const lens = m.strips.map((s) => s.length);
  const stops = new Array(m.cols);
  const samples = 400000;
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < m.cols; c++) stops[c] = Math.floor(rnd() * lens[c]);
    if (evaluateGrid(gridFor(stops, m), m).total > 0) hits++;
  }
  const value = hits / samples;
  hitCache.set(machineId, value);
  return value;
}

/* ── Spin ───────────────────────────────────────────────────────── */

/**
 * Resolve one spin. `bet` is the total bet; it is split across the
 * machine's lines, so the line bet is bet/lineCount and the payout is
 * rounded once at the end rather than per line.
 */
export function spinLines({ serverSeed, clientSeed, nonce, rtp, bet, machine }) {
  const m = getLineMachine(machine);
  const stops = stopsFor({ serverSeed, clientSeed, nonce, machine: m });
  const grid = gridFor(stops, m);
  const evalv = evaluateGrid(grid, m);
  const scale = payScale(rtp, m.id);
  // evalv.total is in line-bet units; total bet buys `lineCount` of them.
  const mult = (evalv.total / m.lines.length) * scale;
  return {
    machine: m.id,
    kind: 'lines',
    stops,
    grid,
    wins: evalv.wins,
    scatterCells: evalv.scatterCells,
    scatterPay: evalv.scatterPay * scale,
    mult,
    payout: Math.round(bet * mult),
  };
}

/** What the client is told about a line machine. */
export function lineMachineView(id, rtp) {
  const m = getLineMachine(id);
  const scale = payScale(rtp, id);
  const sd = returnStandardDeviation(rtp, id);
  return {
    id: m.id,
    kind: 'lines',
    rows: m.rows,
    cols: m.cols,
    lines: m.lines,
    symbols: m.symbols,
    wild: m.wild,
    scatter: m.scatter,
    pay: m.pay.map((row) => row.map((v) => v * scale)),
    scatterPay: m.scatterPay.map((v) => v * scale),
    hit_rate: hitRate(id),
    sd,
  };
}
