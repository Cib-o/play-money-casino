// Client-side reimplementation of the server's RNG, byte for byte,
// on WebCrypto. No DOM and no imports, so the same module runs in the
// browser verifier and in Node's test suite — CI proves the two
// algorithms are identical, and any divergence fails loudly.

const MAX48 = 281474976710656; // 2^48
const encoder = new TextEncoder();

async function hmacKey(serverSeed) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(serverSeed),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** Mirrors src/rng.js uniform(): HMAC-SHA256, first 6 bytes, /2^48. */
export async function uniform(serverSeed, clientSeed, nonce, cursor = 0) {
  const key = await hmacKey(serverSeed);
  for (let c = cursor; c < cursor + 16; c++) {
    const digest = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, encoder.encode(`${clientSeed}:${nonce}:${c}`)),
    );
    const v =
      digest[0] * 2 ** 40 +
      digest[1] * 2 ** 32 +
      digest[2] * 2 ** 24 +
      digest[3] * 2 ** 16 +
      digest[4] * 2 ** 8 +
      digest[5];
    if (v < MAX48) return v / MAX48;
  }
  return 0;
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Slots (mirrors src/games/slots.js) ────────────────────────────
// One entry per machine on the floor, copied from the server registry.
// The duplication is the point: a verifier that imported the server's
// table would prove nothing. test/verify.test.js runs both and fails
// the build if a single weight ever drifts apart.
export const SLOT_MACHINES = {
  orchard: {
    reels: 3,
    mult: [1, 2, 3, 5, 12, 40, 200],
    weight: [0.34, 0.16, 0.07, 0.03, 0.008, 0.0015, 0.0001],
  },
  abyss: {
    reels: 5,
    mult: [1, 2, 4, 7, 15, 60, 220, 800],
    weight: [0.2, 0.11, 0.05, 0.022, 0.008, 0.0016, 0.00025, 0.00004],
  },
  neon: {
    reels: 4,
    mult: [2, 4, 8, 20, 60, 200, 700, 2500],
    weight: [0.095, 0.052, 0.023, 0.008, 0.002, 0.00035, 0.00005, 0.000005],
  },
  classic: {
    reels: 3,
    mult: [0.5, 1, 2, 5, 10, 25, 100, 500, 2000],
    weight: [0.1, 0.08, 0.06, 0.035, 0.015, 0.006, 0.0018, 0.00018, 0.00002],
  },
  temple: {
    reels: 5,
    mult: [1, 3, 6, 15, 45, 150, 600, 2500, 10000],
    weight: [0.1, 0.055, 0.026, 0.009, 0.0026, 0.0006, 0.00011, 0.0000135, 0.0000012],
  },
  cosmos: {
    reels: 4,
    mult: [3, 9, 30, 120, 900, 5000, 25000],
    weight: [0.06, 0.02, 0.0055, 0.0011, 0.00011, 0.0000105, 0.0000011],
  },
};

export const SLOT_MACHINE_IDS = Object.keys(SLOT_MACHINES);
export const SLOT_DEFAULT_MACHINE = 'classic';

// Rounds recorded before the floor had more than one machine carry no
// machine id; they were all played on `classic`.
export function slotMachine(id) {
  return SLOT_MACHINES[id] || SLOT_MACHINES[SLOT_DEFAULT_MACHINE];
}

export const SLOT_MULT = SLOT_MACHINES.classic.mult;
export const SLOT_WEIGHT = SLOT_MACHINES.classic.weight;
export const SLOT_SYMBOL_COUNT = SLOT_MULT.length;

export function slotTable(rtp, machine = SLOT_DEFAULT_MACHINE) {
  const m = slotMachine(machine);
  const sumW = m.weight.reduce((a, b) => a + b, 0);
  const sumWM = m.weight.reduce((a, w, i) => a + w * m.mult[i], 0);
  const q = (rtp * sumW) / sumWM;
  const outs = [0];
  const cum = [1 - q];
  let acc = 1 - q;
  for (let i = 0; i < m.mult.length; i++) {
    acc += (q * m.weight[i]) / sumW;
    outs.push(m.mult[i]);
    cum.push(acc);
  }
  return { outs, cum, q };
}

// ── Payline slots (mirrors src/games/slot-lines.js) ───────────────
// The second slot engine. Where the ladder above decides a multiplier
// and then picks reels to show it, these machines draw a stop position
// per reel and read the win off whatever lands on the paylines.
//
// Same rule as the ladder registry: this is a copy, on purpose. Every
// number a player is paid by is written here where they can read it, and
// test/verify.test.js fails the build if one digit drifts from the
// server's.
export const LINE_MACHINES = {
  meadow: {
    rows: 3,
    cols: 5,
    lineCount: 20,
    symbols: ['square-blue', 'square-green', 'square-yellow', 'octagon-green', 'octagon-blue', 'diamond-green', 'triangle-yellow', 'triangle-purple'],
    wild: 6,
    scatter: 7,
    pay: [[5, 20, 55], [6, 25, 65], [8, 25, 75], [15, 50, 160], [20, 65, 250], [35, 120, 450], [0, 0, 0], [0, 0, 0]],
    scatterPay: [2, 6, 20],
    counts: [
      [11, 10, 10, 4, 3, 2, 0, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
      [11, 10, 10, 4, 3, 2, 2, 2],
    ],
  },
  vault: {
    rows: 3,
    cols: 5,
    lineCount: 20,
    symbols: ['square-purple', 'square-blue', 'square-black', 'octagon-purple', 'octagon-red', 'octagon-yellow', 'diamond-purple', 'triangle-yellow', 'triangle-blue'],
    wild: 7,
    scatter: 8,
    pay: [[5, 20, 70], [5, 20, 70], [5, 25, 95], [20, 95, 480], [30, 140, 720], [40, 200, 1200], [390, 2200, 18000], [0, 0, 0], [0, 0, 0]],
    scatterPay: [4, 16, 100],
    counts: [
      [10, 10, 9, 6, 5, 4, 2, 0, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
      [10, 10, 9, 6, 5, 4, 2, 2, 2],
    ],
  },
  ember: {
    rows: 3,
    cols: 5,
    lineCount: 20,
    symbols: ['square-red', 'square-yellow', 'square-black', 'octagon-red', 'octagon-yellow', 'diamond-red', 'triangle-yellow', 'triangle-green'],
    wild: 6,
    scatter: 7,
    pay: [[0, 10, 55], [0, 15, 65], [0, 20, 85], [20, 110, 700], [40, 220, 1500], [2800, 18000, 140000], [0, 0, 0], [0, 0, 0]],
    scatterPay: [4, 22, 190],
    counts: [
      [14, 13, 12, 6, 4, 1, 0, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
      [14, 13, 12, 6, 4, 1, 2, 2],
    ],
  },
  monolith: {
    rows: 4,
    cols: 5,
    lineCount: 30,
    symbols: ['square-black', 'square-blue', 'square-green', 'octagon-black', 'octagon-blue', 'diamond-blue', 'diamond-yellow', 'triangle-yellow', 'triangle-red'],
    wild: 7,
    scatter: 8,
    pay: [[0, 5, 35], [0, 8, 40], [0, 10, 55], [25, 180, 1100], [55, 390, 2900], [2500, 18000, 140000], [6200, 50000, 385000], [0, 0, 0], [0, 0, 0]],
    scatterPay: [3, 18, 200],
    counts: [
      [17, 16, 15, 6, 4, 1, 1, 0, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
      [17, 16, 15, 6, 4, 1, 1, 2, 2],
    ],
  },
};

export const LINE_MACHINE_IDS = Object.keys(LINE_MACHINES);

export function isLineMachine(id) {
  return Object.prototype.hasOwnProperty.call(LINE_MACHINES, id);
}

/** Even spread of each symbol along a strip; no RNG, so it is checkable. */
export function lineLayout(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const placed = counts.map(() => 0);
  const strip = [];
  for (let i = 0; i < total; i++) {
    let best = -1;
    let bestDeficit = -Infinity;
    for (let s = 0; s < counts.length; s++) {
      if (placed[s] >= counts[s]) continue;
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

/** Connected paths across the grid, flattest first. Order is part of the paytable. */
export function lineBuildLines(rows, cols, count) {
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
  return paths.slice(0, count);
}

// Strips and lines are derived from the registry above, and derived once
// — rebuilding them per spin would be wasted work in a page that may
// replay hundreds of rounds.
const lineCache = new Map();
export function lineMachine(id) {
  if (lineCache.has(id)) return lineCache.get(id);
  const spec = LINE_MACHINES[id];
  if (!spec) return undefined;
  const m = {
    ...spec,
    id,
    strips: spec.counts.map((c) => lineLayout(c)),
    lines: lineBuildLines(spec.rows, spec.cols, spec.lineCount),
  };
  lineCache.set(id, m);
  return m;
}

export function lineWindow(strip, stop, rows) {
  return Array.from({ length: rows }, (_, r) => strip[(stop + r) % strip.length]);
}

export function lineGrid(stops, m) {
  return m.strips.map((strip, c) => lineWindow(strip, stops[c], m.rows));
}

/** Best win on one line, in line-bet units. Wilds substitute; scatters never pay here. */
export function lineWinOf(cells, m) {
  let bestPay = 0;
  let bestSymbol = -1;
  let bestRun = 0;
  for (let s = 0; s < m.symbols.length; s++) {
    if (s === m.scatter) continue;
    let run = 0;
    while (run < cells.length && (cells[run] === s || cells[run] === m.wild)) run++;
    if (run < 3) continue;
    const pay = m.pay[s][run - 3];
    if (pay > bestPay) {
      bestPay = pay;
      bestSymbol = s;
      bestRun = run;
    }
  }
  return { pay: bestPay, symbol: bestSymbol, run: bestRun };
}

export function lineEvaluate(grid, m) {
  const wins = [];
  for (let i = 0; i < m.lines.length; i++) {
    const cells = m.lines[i].map((row, col) => grid[col][row]);
    const w = lineWinOf(cells, m);
    if (w.pay > 0) wins.push({ line: i, symbol: w.symbol, run: w.run, pay: w.pay });
  }
  const scatterCells = [];
  for (let c = 0; c < grid.length; c++) {
    for (let r = 0; r < grid[c].length; r++) {
      if (grid[c][r] === m.scatter) scatterCells.push([c, r]);
    }
  }
  const n = scatterCells.length;
  const scatterPay = n >= 3 ? m.scatterPay[Math.min(n, 5) - 3] : 0;
  const lineTotal = wins.reduce((a, w) => a + w.pay, 0);
  return { wins, scatterCells, scatterPay, total: lineTotal + scatterPay * m.lines.length };
}

// The expected return at the pay values as written. A line touches one
// cell per column, and because the stop is uniform over the strip that
// cell is uniform over the strip whatever row the line runs along — so
// the columns along a line are independent with known marginals, and
// every line has the same expected value. Enumerating one line therefore
// prices all of them.
function lineMarginals(m) {
  return m.strips.map((strip) => {
    const row = new Array(m.symbols.length).fill(0);
    for (const s of strip) row[s] += 1 / strip.length;
    return row;
  });
}

function lineExpected(m) {
  const p = lineMarginals(m);
  const cells = new Array(m.cols);
  let e1 = 0;
  const walk = (c, prob) => {
    if (prob === 0) return;
    if (c === m.cols) {
      e1 += prob * lineWinOf(cells, m).pay;
      return;
    }
    for (let s = 0; s < m.symbols.length; s++) {
      if (p[c][s] === 0) continue;
      cells[c] = s;
      walk(c + 1, prob * p[c][s]);
    }
  };
  walk(0, 1);
  return e1;
}

// Scatters read the whole window, so cells within a column are adjacent
// strip entries and correlated. Enumerating every stop of a reel handles
// that exactly; across reels the stops are independent, so the per-reel
// distributions convolve.
function scatterExpected(m) {
  let dist = [1];
  for (const strip of m.strips) {
    const per = [];
    for (let stop = 0; stop < strip.length; stop++) {
      let k = 0;
      for (let r = 0; r < m.rows; r++) if (strip[(stop + r) % strip.length] === m.scatter) k++;
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
  let e1 = 0;
  for (let k = 3; k < dist.length; k++) {
    if (dist[k]) e1 += dist[k] * m.scatterPay[Math.min(k, 5) - 3];
  }
  return e1;
}

const naturalCache = new Map();
export function lineNaturalReturn(id) {
  if (naturalCache.has(id)) return naturalCache.get(id);
  const m = lineMachine(id);
  const value = lineExpected(m) + scatterExpected(m);
  naturalCache.set(id, value);
  return value;
}

/** One factor applied to the whole paytable so the machine returns `rtp`. */
export function linePayScale(rtp, id) {
  return rtp / lineNaturalReturn(id);
}

/** Replay a payline spin: one uniform draw per reel, cursors 0..cols-1. */
export async function verifySlotLines({ serverSeed, clientSeed, nonce, rtp, machine }) {
  const m = lineMachine(machine);
  const stops = [];
  for (let c = 0; c < m.cols; c++) {
    stops.push(Math.floor((await uniform(serverSeed, clientSeed, nonce, c)) * m.strips[c].length));
  }
  const grid = lineGrid(stops, m);
  const ev = lineEvaluate(grid, m);
  const scale = linePayScale(rtp, machine);
  return {
    machine,
    kind: 'lines',
    stops,
    grid,
    wins: ev.wins,
    scatterCells: ev.scatterCells,
    scatterPay: ev.scatterPay * scale,
    mult: (ev.total / m.lines.length) * scale,
  };
}

// ── Roulette (mirrors src/games/roulette.js) ──────────────────────
export const ROULETTE_RED = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);
const ROULETTE_PAYOUTS = {
  straight: 36, split: 18, red: 2, black: 2, odd: 2, even: 2, dozen: 3, column: 3,
};

function rouletteBetWins(bet, n) {
  switch (bet.type) {
    case 'straight': return n === bet.selection;
    case 'split': return bet.selection[0] === n || bet.selection[1] === n;
    case 'red': return ROULETTE_RED.has(n);
    case 'black': return n >= 1 && !ROULETTE_RED.has(n);
    case 'odd': return n >= 1 && n % 2 === 1;
    case 'even': return n >= 1 && n % 2 === 0;
    case 'dozen': return n >= 1 && Math.floor((n - 1) / 12) === bet.selection;
    case 'column': return n >= 1 && (n - 1) % 3 === bet.selection;
    default: return false;
  }
}

export async function verifyRoulette({ serverSeed, clientSeed, nonce, bets = [] }) {
  const number = Math.floor((await uniform(serverSeed, clientSeed, nonce, 0)) * 37);
  let payout = 0;
  for (const bet of bets) {
    if (rouletteBetWins(bet, number)) payout += bet.amount * ROULETTE_PAYOUTS[bet.type];
  }
  return { number, payout };
}

// ── Dice (mirrors src/games/dice.js) ──────────────────────────────
export function diceWinChance(target, direction) {
  return direction === 'under'
    ? (target * 100) / 10000
    : (9999 - target * 100) / 10000;
}

export async function verifyDice({ serverSeed, clientSeed, nonce, rtp, target, direction }) {
  const r = Math.floor((await uniform(serverSeed, clientSeed, nonce, 0)) * 10000) / 100;
  const win = direction === 'under' ? r < target : r > target;
  const mult = rtp / diceWinChance(target, direction);
  return { r, win, mult };
}

// ── Blackjack (mirrors src/games/blackjack.js) ────────────────────
export function bjHandTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const r = card % 13;
    total += r === 0 ? 11 : r >= 9 ? 10 : r + 1;
    if (r === 0) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

function bjIsBlackjack(cards) {
  return cards.length === 2 && bjHandTotal(cards).total === 21;
}

export async function verifyBlackjack({ serverSeed, clientSeed, nonce, actions = [] }) {
  const draw = async (cursor) =>
    Math.floor((await uniform(serverSeed, clientSeed, nonce, cursor)) * 52);
  const player = [await draw(0), await draw(2)];
  const dealer = [await draw(1), await draw(3)];
  let cursor = 4;
  if (!bjIsBlackjack(player) && !bjIsBlackjack(dealer)) {
    for (const action of actions) {
      if (action === 'hit' || action === 'double') player.push(await draw(cursor++));
    }
    if (bjHandTotal(player).total <= 21) {
      while (bjHandTotal(dealer).total < 17) dealer.push(await draw(cursor++));
    }
  }
  return { player, dealer };
}

// Shared-table blackjack (mirrors src/blackjack-table.js). Each seat
// draws its own independent stream `table:<seat>` and the dealer draws
// `table:d`, so a seat reproduces without needing the other seats.
const TABLE_CLIENT_SEED = 'table';
export async function verifyBlackjackTable({ serverSeed, nonce, seat, actions = [] }) {
  const draw = async (tag, cursor) =>
    Math.floor((await uniform(serverSeed, `${TABLE_CLIENT_SEED}:${tag}`, nonce, cursor)) * 52);
  const player = [await draw(seat, 0), await draw(seat, 1)];
  let cur = 1;
  for (const action of actions) {
    if (action === 'hit' || action === 'double') player.push(await draw(seat, ++cur));
  }
  const dealer = [await draw('d', 0), await draw('d', 1)];
  let dc = 1;
  while (bjHandTotal(dealer).total < 17) dealer.push(await draw('d', ++dc));
  return { player, dealer };
}

export async function verifySlots({ serverSeed, clientSeed, nonce, rtp, machine }) {
  const m = slotMachine(machine);
  const symbols = m.mult.length;
  const { outs, cum } = slotTable(rtp, machine);
  const u = await uniform(serverSeed, clientSeed, nonce, 0);
  let index = cum.length - 1;
  for (let i = 0; i < cum.length; i++) {
    if (u < cum[i]) {
      index = i;
      break;
    }
  }
  const mult = outs[index];
  let reels;
  if (index > 0) {
    reels = Array.from({ length: m.reels }, () => index - 1);
  } else {
    reels = [];
    for (let i = 0; i < m.reels; i++) {
      reels.push(Math.floor((await uniform(serverSeed, clientSeed, nonce, i + 1)) * symbols));
    }
    if (reels.every((r) => r === reels[0])) {
      reels[reels.length - 1] = (reels[reels.length - 1] + 1) % symbols;
    }
  }
  return { mult, reels, u };
}
