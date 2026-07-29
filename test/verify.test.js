import test from 'node:test';
import assert from 'node:assert/strict';
import { uniform as serverUniform, sha256hex as serverSha256 } from '../src/rng.js';
import { spin } from '../src/games/slots.js';
import {
  uniform as clientUniform,
  sha256Hex as clientSha256,
  verifySlots,
} from '../public/js/verify-core.js';

// The browser verifier must mirror the server byte for byte. Running
// the same module under Node's WebCrypto and comparing against the
// node:crypto implementation pins that equivalence in CI — if the two
// ever diverge, verification breaks loudly here first.

const SEED = '9'.repeat(64);

test('client uniform() reproduces the server stream exactly', async () => {
  for (let nonce = 0; nonce < 50; nonce++) {
    for (const cursor of [0, 1, 2, 3, 7]) {
      assert.equal(
        await clientUniform(SEED, 'mirror', nonce, cursor),
        serverUniform(SEED, 'mirror', nonce, cursor),
        `nonce ${nonce} cursor ${cursor}`,
      );
    }
  }
});

test('client sha256 matches the server commitment hash', async () => {
  for (const input of [SEED, 'abc', 'კრედიტი-სათამაშო-ქულაა']) {
    assert.equal(await clientSha256(input), serverSha256(input));
  }
});

test('verifySlots reproduces server spins across RTPs', async () => {
  for (const rtp of [0.9, 0.96, 0.98]) {
    for (let nonce = 0; nonce < 200; nonce++) {
      const server = spin({ serverSeed: SEED, clientSeed: 'replay', nonce, rtp, bet: 10 });
      const client = await verifySlots({ serverSeed: SEED, clientSeed: 'replay', nonce, rtp });
      assert.equal(client.mult, server.mult, `mult at rtp ${rtp} nonce ${nonce}`);
      assert.deepEqual(client.reels, server.reels, `reels at rtp ${rtp} nonce ${nonce}`);
    }
  }
});
