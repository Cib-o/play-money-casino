import { uniform } from '../rng.js';

// Outcome-first slot engine shared by every machine on the floor. The
// multiplier is decided from a single uniform draw against a calibrated
// cumulative table, and the reels are chosen afterwards purely to
// display that result. Multipliers are fixed per machine; only the
// frequency of wins moves with the configured RTP, which is how a real
// par sheet behaves (higher RTP -> higher hit rate).
//
// A "machine" is nothing but a paytable plus a reel count. Every
// machine runs the identical calibration, so the house edge is the same
// everywhere and the only thing a player picks is the shape of the
// ride: how often it pays and how big the tail is. Nothing here knows
// about artwork, colours or sound — that is the client's business.
//
// The `classic` ladder is frozen. Its numbers decide the outcome of
// every slots round already recorded, so changing a weight would make
// old rounds fail verification. New machines get new ids instead.

const CLASSIC_MULT = [0.5, 1, 2, 5, 10, 25, 100, 500, 2000];
const CLASSIC_WEIGHT = [0.1, 0.08, 0.06, 0.035, 0.015, 0.006, 0.0018, 0.00018, 0.00002];

function ladder(id, reels, mult, weight) {
  return {
    id,
    reels,
    mult,
    weight,
    sumW: weight.reduce((a, b) => a + b, 0),
    sumWM: weight.reduce((a, w, i) => a + w * mult[i], 0),
  };
}

// Key order is the order the floor is shown in — calmest first.
// Every ladder is deliberately kept so that q = rtp * sumW / sumWM
// stays below 1 at the highest RTP an admin can configure (0.99);
// `test/slots.test.js` proves it rather than trusting the comment.
export const MACHINES = {
  // Frequent small wins, shallow tail. Nothing below 1x, so a win is
  // never a disguised loss.
  orchard: ladder('orchard', 3,
    [1, 2, 3, 5, 12, 40, 200],
    [0.34, 0.16, 0.07, 0.03, 0.008, 0.0015, 0.0001]),

  // Five reels, middling swings — the long game.
  abyss: ladder('abyss', 5,
    [1, 2, 4, 7, 15, 60, 220, 800],
    [0.2, 0.11, 0.05, 0.022, 0.008, 0.0016, 0.00025, 0.00004]),

  // Four reels, every win at least doubles the stake, but they are rare.
  neon: ladder('neon', 4,
    [2, 4, 8, 20, 60, 200, 700, 2500],
    [0.095, 0.052, 0.023, 0.008, 0.002, 0.00035, 0.00005, 0.000005]),

  // The original three-reel ladder. Frozen: see the note above.
  classic: ladder('classic', 3, CLASSIC_MULT, CLASSIC_WEIGHT),

  // Five reels with a deep tail.
  temple: ladder('temple', 5,
    [1, 3, 6, 15, 45, 150, 600, 2500, 10000],
    [0.1, 0.055, 0.026, 0.009, 0.0026, 0.0006, 0.00011, 0.0000135, 0.0000012]),

  // Long droughts, enormous top end. The most punishing shape here.
  cosmos: ladder('cosmos', 4,
    [3, 9, 30, 120, 900, 5000, 25000],
    [0.06, 0.02, 0.0055, 0.0011, 0.00011, 0.0000105, 0.0000011]),
};

export const MACHINE_IDS = Object.keys(MACHINES);
export const DEFAULT_MACHINE = 'classic';

/** Registry lookup; unknown ids fall back to the default machine. */
export function getMachine(id) {
  return MACHINES[id] || MACHINES[DEFAULT_MACHINE];
}

// Back-compatible aliases for the original single-machine API.
export const MULT = CLASSIC_MULT;
export const WEIGHT = CLASSIC_WEIGHT;
export const SYMBOL_COUNT = CLASSIC_MULT.length;

/**
 * Cumulative outcome table for a machine at a given RTP.
 *
 * The losing outcome is its own explicit entry at index 0. Building
 * the table by starting the accumulator at 1-q *without* that entry
 * makes the first win threshold swallow the entire loss region and
 * every round pays out — the table must always begin with (0, 1-q).
 */
export function buildTable(rtp, machine = DEFAULT_MACHINE) {
  const m = getMachine(machine);
  const q = (rtp * m.sumW) / m.sumWM; // total win probability
  const outs = [0];
  const cum = [1 - q];
  let acc = 1 - q;
  for (let i = 0; i < m.mult.length; i++) {
    acc += (q * m.weight[i]) / m.sumW;
    outs.push(m.mult[i]);
    cum.push(acc);
  }
  return { outs, cum, q };
}

/** Expected return of the table — must equal rtp to within 1e-12. */
export function theoreticalReturn(rtp, machine = DEFAULT_MACHINE) {
  const { outs, cum } = buildTable(rtp, machine);
  let prev = 0;
  let er = 0;
  for (let i = 0; i < outs.length; i++) {
    er += outs[i] * (cum[i] - prev);
    prev = cum[i];
  }
  return er;
}

/**
 * Standard deviation of the payout multiplier. This is the honest
 * measure of how wild a machine feels, and it is what the volatility
 * badge in the lobby is derived from — no hand-assigned labels.
 */
export function standardDeviation(rtp, machine = DEFAULT_MACHINE) {
  const m = getMachine(machine);
  const { q } = buildTable(rtp, machine);
  let em2 = 0;
  for (let i = 0; i < m.mult.length; i++) {
    em2 += m.mult[i] * m.mult[i] * ((q * m.weight[i]) / m.sumW);
  }
  return Math.sqrt(Math.max(0, em2 - rtp * rtp));
}

export function volatilityBand(sd) {
  if (sd < 4) return 'low';
  if (sd < 10) return 'mid';
  if (sd < 20) return 'high';
  return 'extreme';
}

/** Index into (outs, cum) for a uniform draw u. */
export function pickIndex(table, u) {
  for (let i = 0; i < table.cum.length; i++) {
    if (u < table.cum[i]) return i;
  }
  return table.cum.length - 1;
}

/**
 * Reels for a decided outcome. index 0 is the loss entry; index i>0
 * maps to symbol i-1 shown on every reel. Losses draw one symbol per
 * reel from cursors 1..reels of the same HMAC stream with a forced
 * mismatch, so a losing round can never render as a full match. No
 * near-miss weighting: loss reels are plain uniform draws.
 */
export function reelsFor({ serverSeed, clientSeed, nonce, index, machine = DEFAULT_MACHINE }) {
  const m = getMachine(machine);
  const symbols = m.mult.length;
  if (index > 0) {
    const s = index - 1;
    return Array.from({ length: m.reels }, () => s);
  }
  const reels = Array.from({ length: m.reels }, (_, i) =>
    Math.floor(uniform(serverSeed, clientSeed, nonce, i + 1) * symbols),
  );
  if (reels.every((r) => r === reels[0])) {
    reels[reels.length - 1] = (reels[reels.length - 1] + 1) % symbols;
  }
  return reels;
}

/** Integer credits paid for a bet at a multiplier. */
export function payoutFor(bet, mult) {
  return Math.round(bet * mult);
}

/** Resolve one spin. Pure: same seeds and nonce always reproduce it. */
export function spin({ serverSeed, clientSeed, nonce, rtp, bet, machine = DEFAULT_MACHINE }) {
  const m = getMachine(machine);
  const table = buildTable(rtp, m.id);
  const u = uniform(serverSeed, clientSeed, nonce, 0);
  const index = pickIndex(table, u);
  const mult = table.outs[index];
  const reels = reelsFor({ serverSeed, clientSeed, nonce, index, machine: m.id });
  return { machine: m.id, mult, payout: payoutFor(bet, mult), reels };
}

/**
 * What the client is told about a machine. The paytable comes straight
 * out of the registry, so the odds on screen are the odds being played
 * — there is no second, prettier copy of the numbers anywhere.
 */
export function machineView(id, rtp) {
  const m = getMachine(id);
  const { q } = buildTable(rtp, m.id);
  const sd = standardDeviation(rtp, m.id);
  return {
    id: m.id,
    reels: m.reels,
    symbols: m.mult.length,
    mult: m.mult,
    hit_rate: q,
    top: m.mult[m.mult.length - 1],
    sd,
    volatility: volatilityBand(sd),
  };
}
