import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-session-secret-0123456789abcdef0123456789';

function makeApp() {
  const db = openDb(':memory:');
  return buildApp({ db, config: { sessionSecret: SECRET, production: false }, logger: false });
}

// The Content-Security-Policy is load-bearing, and the way it fails is
// quiet: the browser logs to a console nobody is reading and carries on
// with the offending rule dropped. That is how the reel grid came to be
// drawn transposed for a while — every cell asked for its square with a
// style="" attribute, style-src 'self' refused all of them, and the grid
// auto-flowed the cells row by row instead. Nothing threw. The screen
// simply stopped agreeing with the numbers behind it.
//
// So the policy is pinned here, and so is the rule it implies about how
// the frontend may set styles.

test('the policy allows no inline or eval escape hatch', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/api/public' });
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, 'every response carries a policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /font-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!csp.includes('unsafe-inline'), csp);
  assert.ok(!csp.includes('unsafe-eval'), csp);
  // The fonts are served from this repo now; no third-party origin is
  // named anywhere in the policy.
  assert.ok(!/https?:\/\//.test(csp), csp);
  await app.close();
});

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// Property assignments (el.style.color = …, el.style.setProperty(…)) are
// not covered by style-src and keep working. Attributes do not. This is
// the only difference that matters, and it is invisible in review, so it
// gets checked instead of remembered.
test('no shipped file sets styles through an attribute the policy blocks', () => {
  const files = walk(path.join(ROOT, 'public')).filter((f) => /\.(html|js)$/.test(f));
  assert.ok(files.length > 20, 'found the frontend');
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      const bad =
        /<[^>]*\sstyle\s*=/.test(line) ||          // style="" in markup
        /setAttribute\(\s*['"`]style['"`]/.test(line) || // …and through the DOM
        /attrs:\s*\{[^}]*\bstyle\s*:/.test(line);  // …and through el()'s attrs bag
      if (bad) offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `inline style attributes are dropped by style-src 'self':\n${offenders.join('\n')}`);
});
