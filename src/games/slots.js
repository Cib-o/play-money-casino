import { uniform } from '../rng.js';

// Three-reel slot, outcome-first: the multiplier is decided from a
// single uniform draw against a calibrated cumulative table, and reels
// are chosen afterwards purely to display that result. Multipliers are
// fixed; only the frequency of wins moves with the configured RTP,
// which is how a real par sheet behaves (higher RTP -> higher hit
// rate). At RTP 0.96 the hit rate lands at ~27.6%.

export const MULT = [0.5, 1, 2, 5, 10, 25, 100, 500, 2000];
export const WEIGHT = [0.1, 0.08, 0.06, 0.035, 0.015, 0.006, 0.0018, 0.00018, 0.00002];

// One display symbol per multiplier tier, referenced by index; the
// client owns the artwork. Losses draw from the same set.
export const SYMBOL_COUNT = MULT.length;

const SUM_W = WEIGHT.reduce((a, b) => a + b, 0);
const SUM_WM = WEIGHT.reduce((a, w, i) => a + w * MULT[i], 0);

/**
 * Cumulative outcome table for a given RTP.
 *
 * The losing outcome is its own explicit entry at index 0. Building
 * the table by starting the accumulator at 1-q *without* that entry
 * makes the first win threshold swallow the entire loss region and
 * every round pays out — the table must always begin with (0, 1-q).
 */
export function buildTable(rtp) {
  const q = (rtp * SUM_W) / SUM_WM; // total win probability
  const outs = [0];
  const cum = [1 - q];
  let acc = 1 - q;
  for (let i = 0; i < MULT.length; i++) {
    acc += (q * WEIGHT[i]) / SUM_W;
    outs.push(MULT[i]);
    cum.push(acc);
  }
  return { outs, cum, q };
}

/** Expected return of the table — must equal rtp to within 1e-12. */
export function theoreticalReturn(rtp) {
  const { outs, cum } = buildTable(rtp);
  let prev = 0;
  let er = 0;
  for (let i = 0; i < outs.length; i++) {
    er += outs[i] * (cum[i] - prev);
    prev = cum[i];
  }
  return er;
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
 * maps to symbol i-1 shown three times. Losses draw three symbols from
 * cursors 1-3 of the same HMAC stream with a forced mismatch, so a
 * losing round can never render as three of a kind. No near-miss
 * weighting: loss reels are plain uniform draws.
 */
export function reelsFor({ serverSeed, clientSeed, nonce, index }) {
  if (index > 0) {
    const s = index - 1;
    return [s, s, s];
  }
  const draw = (cursor) =>
    Math.floor(uniform(serverSeed, clientSeed, nonce, cursor) * SYMBOL_COUNT);
  const reels = [draw(1), draw(2), draw(3)];
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    reels[2] = (reels[2] + 1) % SYMBOL_COUNT;
  }
  return reels;
}

/** Integer credits paid for a bet at a multiplier. */
export function payoutFor(bet, mult) {
  return Math.round(bet * mult);
}

/** Resolve one spin. Pure: same seeds and nonce always reproduce it. */
export function spin({ serverSeed, clientSeed, nonce, rtp, bet }) {
  const table = buildTable(rtp);
  const u = uniform(serverSeed, clientSeed, nonce, 0);
  const index = pickIndex(table, u);
  const mult = table.outs[index];
  const reels = reelsFor({ serverSeed, clientSeed, nonce, index });
  return { mult, payout: payoutFor(bet, mult), reels };
}
