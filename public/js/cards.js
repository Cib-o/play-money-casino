// Card model, rendering and cosmetic randomness for the live blackjack
// table. Card indexes match the server: rank = card % 13
// (0=A … 8=9, 9=10, 10=J, 11=Q, 12=K), suit = floor(card / 13)
// (0 ♠, 1 ♥, 2 ♦, 3 ♣).
//
// IMPORTANT: everything random in here is *cosmetic* — bot hands, the
// shoe, seat assignment, masked names. It touches no balance and no
// verifiable outcome, so it is decoration, not a game result. Even so
// it uses crypto.getRandomValues rather than Math.random, keeping the
// "no Math.random anywhere" property of the project intact. The
// player's real hand never comes from here — it comes from the
// commit-reveal server engine.

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['♠', '♥', '♦', '♣'];
const RED_SUITS = new Set([1, 2]); // hearts, diamonds

export const rankOf = (card) => card % 13;
export const suitOf = (card) => Math.floor(card / 13);

export function cardValue(card) {
  const r = rankOf(card);
  if (r === 0) return 11;
  if (r >= 9) return 10;
  return r + 1;
}

export function handTotal(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += cardValue(card);
    if (rankOf(card) === 0) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export const isBlackjack = (cards) => cards.length === 2 && handTotal(cards).total === 21;

// ── cosmetic randomness (crypto, unbiased) ────────────────────────
export function randInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let v;
  do {
    crypto.getRandomValues(buf);
    v = buf[0];
  } while (v >= limit);
  return v % n;
}

export const pick = (arr) => arr[randInt(arr.length)];

/** Fresh multi-deck shoe, Fisher–Yates shuffled. */
export function makeShoe(decks = 6) {
  const shoe = [];
  for (let d = 0; d < decks; d++) {
    for (let c = 0; c < 52; c++) shoe.push(c);
  }
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

// ── bot behaviour ─────────────────────────────────────────────────
// Simplified basic strategy — enough to look like a real player, not
// a solver. Bots hit/stand/double only (no split/insurance), matching
// what the real engine offers.
export function botAction(hand, dealerUp) {
  const { total, soft } = handTotal(hand);
  const up = cardValue(dealerUp);
  if (hand.length === 2 && (total === 10 || total === 11) && up <= 9 && randInt(3) === 0) {
    return 'double';
  }
  if (soft) return total <= 17 ? 'hit' : 'stand';
  if (total <= 11) return 'hit';
  if (total >= 17) return 'stand';
  return up >= 7 ? 'hit' : 'stand'; // hard 12–16
}

/** Dealer draws to a hard/soft 17 (stands on soft 17). Mutates hand. */
export function dealerDraw(hand, drawCard) {
  while (handTotal(hand).total < 17) hand.push(drawCard());
  return hand;
}

// ── masked bot names (e.g. "g****5", "1***l") ─────────────────────
const NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function maskedName() {
  const len = 4 + randInt(6); // 4–9 chars
  let raw = '';
  for (let i = 0; i < len; i++) raw += NAME_ALPHABET[randInt(NAME_ALPHABET.length)];
  return raw[0] + '*'.repeat(len - 2) + raw[len - 1];
}

const AVATAR_HUES = [8, 28, 48, 145, 170, 200, 260, 290, 320];
export const avatarHue = () => pick(AVATAR_HUES);

// ── DOM rendering ─────────────────────────────────────────────────
// All values here are library constants (ranks/suits), never
// user-supplied, so innerHTML carries no injection risk and the strict
// CSP (script-src 'self') is unaffected.
export function cardEl(card, { faceDown = false } = {}) {
  const el = document.createElement('div');
  el.className = 'pcard';
  if (faceDown) {
    el.classList.add('down');
    el.innerHTML = '<span class="pcard-back"></span>';
    el.dataset.card = String(card);
    return el;
  }
  const r = rankOf(card);
  const s = suitOf(card);
  if (RED_SUITS.has(s)) el.classList.add('red');
  el.innerHTML =
    `<span class="pcard-corner tl">${RANKS[r]}<b>${SUITS[s]}</b></span>` +
    `<span class="pcard-pip">${SUITS[s]}</span>` +
    `<span class="pcard-corner br">${RANKS[r]}<b>${SUITS[s]}</b></span>`;
  return el;
}

/** Flip a face-down card element to its face. */
export function revealCard(el) {
  const card = Number(el.dataset.card);
  const face = cardEl(card);
  face.classList.add('flip-in');
  el.replaceWith(face);
  return face;
}
