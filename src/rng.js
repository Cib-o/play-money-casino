import { createHash, createHmac, randomBytes } from 'node:crypto';

// All game outcomes derive from this file and node:crypto. There is no
// Math.random() anywhere in outcome generation, and the client never
// influences a result beyond supplying its half of the seed pair.
//
// Commit-reveal: the server generates server_seed (32 random bytes,
// hex) and publishes only sha256(server_seed). Each round consumes
// HMAC-SHA256(server_seed, `${clientSeed}:${nonce}:${cursor}`). When
// the seed rotates the old server_seed is revealed, so every round
// played under it can be recomputed by anyone — see /verify, which
// mirrors this algorithm byte for byte in the browser.

const MAX48 = 281474976710656; // 2^48

/**
 * Uniform float in [0, 1) with rejection sampling so there is no
 * modulo bias. The verifier page reimplements exactly this — if the
 * two ever diverge, verification fails loudly, which is the point.
 */
export function uniform(serverSeed, clientSeed, nonce, cursor = 0) {
  for (let c = cursor; c < cursor + 16; c++) {
    const digest = createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${c}`)
      .digest();
    const v = digest.readUIntBE(0, 6); // 0 .. 2^48-1
    if (v < MAX48) return v / MAX48;
  }
  return 0;
}

/** Uniform integer in [0, n). */
export function uniformInt(serverSeed, clientSeed, nonce, cursor, n) {
  return Math.floor(uniform(serverSeed, clientSeed, nonce, cursor) * n) % n;
}

export function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Fresh server seed plus the hash that gets published up front. */
export function newSeedPair() {
  const serverSeed = randomBytes(32).toString('hex');
  return { serverSeed, hash: sha256hex(serverSeed) };
}

export function randomClientSeed() {
  return randomBytes(8).toString('hex');
}
