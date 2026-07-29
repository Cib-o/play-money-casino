import { uniform } from '../rng.js';

// Roll-under / roll-over dice. The roll r takes one of 10,000 equally
// likely values 0.00 … 99.99, so win probabilities are exact rationals:
//   under T: wins when r < T   → p = 100·T / 10000
//   over  T: wins when r > T   → p = (9999 − 100·T) / 10000
// The payout multiplier is rtp / p, which makes the expected return
// equal the configured RTP by construction — no calibration table
// needed, the identity p · (rtp/p) = rtp is the whole proof.

export const MIN_TARGET = 2;
export const MAX_TARGET = 98;

export function validTarget(target) {
  return Number.isInteger(target) && target >= MIN_TARGET && target <= MAX_TARGET;
}

/** Exact win probability as a rational over the 10,000 roll values. */
export function winChance(target, direction) {
  return direction === 'under'
    ? (target * 100) / 10000
    : (9999 - target * 100) / 10000;
}

export function multiplier(rtp, target, direction) {
  return rtp / winChance(target, direction);
}

/** Resolve one roll. Pure: same seeds and nonce always reproduce it. */
export function roll({ serverSeed, clientSeed, nonce, rtp, bet, target, direction }) {
  const r = Math.floor(uniform(serverSeed, clientSeed, nonce, 0) * 10000) / 100;
  const win = direction === 'under' ? r < target : r > target;
  const mult = multiplier(rtp, target, direction);
  const payout = win ? Math.round(bet * mult) : 0;
  return { r, win, mult, payout };
}
