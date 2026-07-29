import { uniform } from '../rng.js';

// Single-hand blackjack vs the dealer. Infinite deck (every card an
// independent uniform draw over 52), dealer stands on ALL 17s
// including soft 17, blackjack pays 3:2, double on the first two
// cards, no splits. Card order is fixed so a finished round can be
// replayed from the seeds and the action list alone:
//   cursor 0 → player, 1 → dealer up, 2 → player, 3 → dealer hole,
//   then one cursor per hit/double card, then the dealer's draws.

export function makeDraw({ serverSeed, clientSeed, nonce }) {
  return (cursor) => Math.floor(uniform(serverSeed, clientSeed, nonce, cursor) * 52);
}

export function rank(card) {
  return card % 13; // 0=A, 1=2 … 8=9, 9=10, 10=J, 11=Q, 12=K
}

export function cardValue(card) {
  const r = rank(card);
  if (r === 0) return 11;
  if (r >= 9) return 10;
  return r + 1;
}

/** Best total with aces demoted as needed; soft = an ace still at 11. */
export function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += cardValue(card);
    if (rank(card) === 0) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export function isBlackjack(cards) {
  return cards.length === 2 && handTotal(cards).total === 21;
}

/** Dealer draws to 17 and stands on every 17, soft included (S17). */
export function dealerPlay(dealer, draw, cursor) {
  const hand = [...dealer];
  let c = cursor;
  while (handTotal(hand).total < 17) {
    hand.push(draw(c++));
  }
  return { hand, cursor: c };
}

/**
 * Settle a finished round. `stake` is the total amount debited
 * (bet, or 2×bet after a double); payout includes the returned stake.
 * A natural blackjack pays 3:2 on the original bet.
 */
export function settleOutcome(player, dealer, { bet, doubled }) {
  const stake = doubled ? bet * 2 : bet;
  const p = handTotal(player).total;
  const d = handTotal(dealer).total;
  const playerBJ = isBlackjack(player);
  const dealerBJ = isBlackjack(dealer);
  if (playerBJ && dealerBJ) return { result: 'push', payout: stake };
  if (playerBJ) return { result: 'blackjack', payout: Math.round(bet * 2.5) };
  if (dealerBJ) return { result: 'lose', payout: 0 };
  if (p > 21) return { result: 'lose', payout: 0 };
  if (d > 21) return { result: 'win', payout: stake * 2 };
  if (p > d) return { result: 'win', payout: stake * 2 };
  if (p < d) return { result: 'lose', payout: 0 };
  return { result: 'push', payout: stake };
}

/**
 * Deterministic replay of a whole round from the action list — the
 * exact function the browser verifier mirrors.
 */
export function replay({ draw, actions }) {
  const player = [draw(0), draw(2)];
  const dealer = [draw(1), draw(3)];
  let cursor = 4;
  if (!isBlackjack(player) && !isBlackjack(dealer)) {
    for (const action of actions) {
      if (action === 'hit' || action === 'double') player.push(draw(cursor++));
    }
    if (handTotal(player).total <= 21) {
      const played = dealerPlay(dealer, draw, cursor);
      return { player, dealer: played.hand };
    }
  }
  return { player, dealer };
}
