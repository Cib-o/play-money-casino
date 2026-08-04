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
