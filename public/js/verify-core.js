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
export const SLOT_MULT = [0.5, 1, 2, 5, 10, 25, 100, 500, 2000];
export const SLOT_WEIGHT = [0.1, 0.08, 0.06, 0.035, 0.015, 0.006, 0.0018, 0.00018, 0.00002];
export const SLOT_SYMBOL_COUNT = SLOT_MULT.length;

export function slotTable(rtp) {
  const sumW = SLOT_WEIGHT.reduce((a, b) => a + b, 0);
  const sumWM = SLOT_WEIGHT.reduce((a, w, i) => a + w * SLOT_MULT[i], 0);
  const q = (rtp * sumW) / sumWM;
  const outs = [0];
  const cum = [1 - q];
  let acc = 1 - q;
  for (let i = 0; i < SLOT_MULT.length; i++) {
    acc += (q * SLOT_WEIGHT[i]) / sumW;
    outs.push(SLOT_MULT[i]);
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

export async function verifySlots({ serverSeed, clientSeed, nonce, rtp }) {
  const { outs, cum } = slotTable(rtp);
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
    const s = index - 1;
    reels = [s, s, s];
  } else {
    const draw = async (cursor) =>
      Math.floor((await uniform(serverSeed, clientSeed, nonce, cursor)) * SLOT_SYMBOL_COUNT);
    reels = [await draw(1), await draw(2), await draw(3)];
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      reels[2] = (reels[2] + 1) % SLOT_SYMBOL_COUNT;
    }
  }
  return { mult, reels, u };
}
