import { uniform } from '../rng.js';

// European single-zero roulette. The paytable is the classic one, so
// the house edge is exactly 1/37 (~2.7%) for every bet type — the
// configurable RTP setting applies to the calibrated games (slots,
// dice), not here. Payout factors below include the returned stake.

export const RED = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const PAYOUTS = {
  straight: 36,
  split: 18,
  red: 2,
  black: 2,
  odd: 2,
  even: 2,
  dozen: 3,
  column: 3,
};

/**
 * A split must join two physically adjacent numbers on the layout:
 * vertically inside a street (difference 1, not across street ends) or
 * horizontally between streets (difference 3), plus 0 with 1, 2 or 3.
 */
export function validSplit(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a > b) [a, b] = [b, a];
  if (a === 0) return b >= 1 && b <= 3;
  if (a < 1 || b > 36) return false;
  if (b - a === 3) return true;
  if (b - a === 1) return a % 3 !== 0;
  return false;
}

/** Structural validation of one bet object (amount is checked upstream). */
export function validateBet(bet) {
  switch (bet.type) {
    case 'straight':
      return Number.isInteger(bet.selection) && bet.selection >= 0 && bet.selection <= 36;
    case 'split':
      return (
        Array.isArray(bet.selection) &&
        bet.selection.length === 2 &&
        validSplit(bet.selection[0], bet.selection[1])
      );
    case 'red':
    case 'black':
    case 'odd':
    case 'even':
      return bet.selection === undefined || bet.selection === null;
    case 'dozen':
    case 'column':
      return Number.isInteger(bet.selection) && bet.selection >= 0 && bet.selection <= 2;
    default:
      return false;
  }
}

export function betWins(bet, n) {
  switch (bet.type) {
    case 'straight':
      return n === bet.selection;
    case 'split':
      return bet.selection[0] === n || bet.selection[1] === n;
    case 'red':
      return RED.has(n);
    case 'black':
      return n >= 1 && !RED.has(n);
    case 'odd':
      return n >= 1 && n % 2 === 1;
    case 'even':
      return n >= 1 && n % 2 === 0;
    case 'dozen':
      return n >= 1 && Math.floor((n - 1) / 12) === bet.selection;
    case 'column':
      return n >= 1 && (n - 1) % 3 === bet.selection;
    default:
      return false;
  }
}

/** Winning pocket for a round: uniform over the 37 pockets. */
export function spinNumber({ serverSeed, clientSeed, nonce }) {
  return Math.floor(uniform(serverSeed, clientSeed, nonce, 0) * 37);
}

/** Settle a list of bets against a pocket. Integer credits throughout. */
export function settle(bets, n) {
  let payout = 0;
  const results = bets.map((bet) => {
    const win = betWins(bet, n);
    const amount = win ? bet.amount * PAYOUTS[bet.type] : 0;
    payout += amount;
    return { type: bet.type, selection: bet.selection ?? null, amount: bet.amount, win, payout: amount };
  });
  return { payout, results };
}
