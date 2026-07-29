import {
  createHmac,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

// scrypt over argon2 on purpose: argon2 is a native module with a
// compile step that fails on exactly the machines this project targets.
// Parameters live inside the hash string so they can be raised later
// without invalidating existing hashes.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Pre-computed hash used to burn identical scrypt work when a username
// does not exist, so login timing cannot reveal which usernames are real.
const DECOY_HASH = hashPassword('decoy-password-for-timing-only');
export function decoyVerify(password = 'x') {
  verifyPassword(password, DECOY_HASH);
}

// ── Sessions ─────────────────────────────────────────────────────────
// Stateless signed tokens: userId.issuedAt.HMAC-SHA256(payload).
// No session table to prune; revocation still works because every
// request re-reads the user row and disabled accounts fail that check.

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(userId, secret, issuedAt = Math.floor(Date.now() / 1000)) {
  const payload = `${userId}.${issuedAt}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the userId for a valid, unexpired token, else null. */
export function verifySessionToken(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, issuedAt, signature] = parts;
  if (!userId || !/^\d+$/.test(issuedAt)) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(`${userId}.${issuedAt}`, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (now - Number(issuedAt) > SESSION_TTL_SECONDS) return null;
  return userId;
}

// ── Generated player passwords ───────────────────────────────────────
// Three words and two digits (quartz-fjord-cedar-37): ~10^7 times fewer
// guesses than random bytes would give, but far beyond what the login
// rate limit allows an attacker, and an operator can read one out loud
// over the phone without spelling it letter by letter.

const WORDS = [
  'amber', 'anchor', 'apple', 'arrow', 'aspen', 'atlas', 'autumn', 'badge',
  'bamboo', 'basil', 'beacon', 'berry', 'birch', 'bison', 'blaze', 'bloom',
  'bolt', 'breeze', 'brick', 'bridge', 'bronze', 'brook', 'cabin', 'cactus',
  'camel', 'candle', 'canyon', 'carbon', 'cedar', 'chalk', 'cherry', 'chess',
  'cliff', 'cloud', 'clover', 'cobalt', 'comet', 'copper', 'coral', 'cotton',
  'crane', 'crater', 'crystal', 'delta', 'denim', 'dune', 'eagle', 'ebony',
  'ember', 'falcon', 'fern', 'field', 'fjord', 'flint', 'forest', 'fossil',
  'frost', 'galaxy', 'garnet', 'geyser', 'ginger', 'glacier', 'granite',
  'grape', 'gravel', 'grove', 'harbor', 'hazel', 'heron', 'hollow', 'honey',
  'ivory', 'jade', 'jasper', 'juniper', 'kite', 'lagoon', 'lantern', 'larch',
  'lemon', 'lilac', 'linen', 'lotus', 'lunar', 'maple', 'marble', 'meadow',
  'mesa', 'meteor', 'mint', 'mist', 'moss', 'nectar', 'nickel', 'north',
  'nova', 'oak', 'ocean', 'olive', 'onyx', 'opal', 'orbit', 'orchid',
  'osprey', 'otter', 'panda', 'pearl', 'pebble', 'pecan', 'penguin', 'pepper',
  'pine', 'planet', 'plum', 'pond', 'poplar', 'prism', 'quartz', 'quill',
  'raven', 'reef', 'ridge', 'river', 'rowan', 'ruby', 'saffron', 'sage',
  'salmon', 'sand', 'sequoia', 'shadow', 'shore', 'sierra', 'silver', 'slate',
  'sonar', 'spruce', 'steel', 'stone', 'storm', 'summit', 'sunset', 'swan',
  'thyme', 'tiger', 'timber', 'topaz', 'trail', 'tulip', 'tundra', 'turtle',
  'valley', 'velvet', 'violet', 'walnut', 'willow', 'winter', 'wolf', 'zephyr',
];

export function generatePassword() {
  const pick = () => WORDS[randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${randomInt(10, 100)}`;
}
