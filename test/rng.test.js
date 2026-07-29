import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { uniform, uniformInt, newSeedPair, sha256hex } from '../src/rng.js';

// Fixed seeds make every "statistical" assertion below fully
// deterministic: the stream is a pure function of its inputs, so these
// tests cannot flake in CI.
const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);

test('identical seed, nonce and cursor reproduce the outcome', () => {
  for (let nonce = 0; nonce < 100; nonce++) {
    assert.equal(
      uniform(SEED_A, 'client-seed', nonce),
      uniform(SEED_A, 'client-seed', nonce),
    );
  }
  assert.equal(uniform(SEED_A, 'x', 7, 3), uniform(SEED_A, 'x', 7, 3));
});

test('a different server seed changes the stream', () => {
  let differing = 0;
  for (let nonce = 0; nonce < 50; nonce++) {
    if (uniform(SEED_A, 'c', nonce) !== uniform(SEED_B, 'c', nonce)) differing++;
  }
  assert.equal(differing, 50);
});

test('client seed, nonce and cursor each advance the stream', () => {
  assert.notEqual(uniform(SEED_A, 'c1', 0), uniform(SEED_A, 'c2', 0));
  assert.notEqual(uniform(SEED_A, 'c1', 0), uniform(SEED_A, 'c1', 1));
  assert.notEqual(uniform(SEED_A, 'c1', 0, 0), uniform(SEED_A, 'c1', 0, 1));
});

test('uniform() stays in [0, 1)', () => {
  for (let nonce = 0; nonce < 1000; nonce++) {
    const u = uniform(SEED_A, 'range', nonce);
    assert.ok(u >= 0 && u < 1, `out of range: ${u}`);
  }
});

test('uniform() is flat across 16 buckets', () => {
  const N = 160000;
  const buckets = new Array(16).fill(0);
  for (let nonce = 0; nonce < N; nonce++) {
    buckets[Math.floor(uniform(SEED_A, 'bucket-test', nonce) * 16)]++;
  }
  const expected = N / 16;
  // Four standard errors of a binomial count at p = 1/16.
  const tolerance = 4 * Math.sqrt(N * (1 / 16) * (15 / 16));
  for (let i = 0; i < 16; i++) {
    assert.ok(
      Math.abs(buckets[i] - expected) < tolerance,
      `bucket ${i}: ${buckets[i]} vs ${expected} ±${tolerance.toFixed(1)}`,
    );
  }
});

test('uniformInt() covers [0, n) and nothing else', () => {
  const seen = new Set();
  for (let nonce = 0; nonce < 2000; nonce++) {
    const v = uniformInt(SEED_A, 'int', nonce, 0, 37);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 37);
    seen.add(v);
  }
  assert.equal(seen.size, 37);
});

test('published hash commits to the revealed server seed', () => {
  const { serverSeed, hash } = newSeedPair();
  assert.match(serverSeed, /^[0-9a-f]{64}$/);
  assert.equal(hash, createHash('sha256').update(serverSeed).digest('hex'));
  assert.equal(hash, sha256hex(serverSeed));
});

test('seed pairs are never reused', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const { serverSeed } = newSeedPair();
    assert.ok(!seen.has(serverSeed));
    seen.add(serverSeed);
  }
});
