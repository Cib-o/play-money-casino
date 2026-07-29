import { newSeedPair, randomClientSeed } from './rng.js';

/** Per-user commit-reveal state. Created lazily on first use. */
export function getOrCreateSeed(db, userId) {
  const existing = db.prepare('SELECT * FROM seeds WHERE user_id = ?').get(userId);
  if (existing) return existing;
  const { serverSeed, hash } = newSeedPair();
  db.prepare(
    'INSERT INTO seeds (user_id, server_seed, hash, client_seed, nonce) VALUES (?, ?, ?, ?, 0)',
  ).run(userId, serverSeed, hash, randomClientSeed());
  return db.prepare('SELECT * FROM seeds WHERE user_id = ?').get(userId);
}

export function setClientSeed(db, userId, clientSeed) {
  getOrCreateSeed(db, userId);
  db.prepare('UPDATE seeds SET client_seed = ? WHERE user_id = ?').run(clientSeed, userId);
}

/**
 * Rotate the user's seed pair: reveal the old server seed by writing it
 * onto every round played under its hash, then start a fresh pair at
 * nonce 0. After this, anyone can recompute those rounds byte for byte.
 */
export function rotateSeed(db, userId) {
  const old = getOrCreateSeed(db, userId);
  const next = newSeedPair();
  db.transaction(() => {
    db.prepare(
      'UPDATE rounds SET server_seed = ? WHERE user_id = ? AND server_seed_hash = ?',
    ).run(old.server_seed, userId, old.hash);
    db.prepare(
      'UPDATE seeds SET server_seed = ?, hash = ?, nonce = 0 WHERE user_id = ?',
    ).run(next.serverSeed, next.hash, userId);
  })();
  return {
    revealedServerSeed: old.server_seed,
    revealedHash: old.hash,
    newHash: next.hash,
    clientSeed: old.client_seed,
  };
}
