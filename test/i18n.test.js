import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS } from '../public/js/strings.js';
import { FLOOR_IDS } from '../src/games/slot-floor.js';
import { MACHINE_IDS as RETIRED_IDS } from '../src/games/slots.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The string table is pure data, so the frontend's i18n source can be
// checked in CI: if the key sets ever drift apart, some UI language
// would leak untranslated — that must fail the build, not a user.

test('en and ka string tables carry identical key sets', () => {
  const en = Object.keys(STRINGS.en).sort();
  const ka = Object.keys(STRINGS.ka).sort();
  assert.deepEqual(ka, en);
});

test('no empty strings in either language', () => {
  for (const locale of ['en', 'ka']) {
    for (const [key, value] of Object.entries(STRINGS[locale])) {
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

test('the play-money notice matches the required wording exactly', () => {
  assert.equal(
    STRINGS.en.footer_notice,
    'Credits are play points. They have no monetary value and cannot be bought or cashed out.',
  );
  assert.equal(
    STRINGS.ka.footer_notice,
    'კრედიტი სათამაშო ქულაა. მას ფულადი ღირებულება არ აქვს, არ იყიდება და არ განაღდდება.',
  );
});

// Adding a machine to the registry without adding its strings would put
// the raw key on the lobby card in both languages.
test('every machine on the floor is named and described in both languages', () => {
  for (const locale of ['en', 'ka']) {
    for (const id of FLOOR_IDS) {
      assert.ok(STRINGS[locale][`slot_name_${id}`], `${locale}: no name for ${id}`);
      assert.ok(STRINGS[locale][`slot_tag_${id}`], `${locale}: no tagline for ${id}`);
    }
  }
});

// The retired ladder cabinets have no tagline any more — nothing lists
// them — but /verify still puts every machine that can appear on a
// recorded round into its picker, by name. Dropping these names would
// leave `slot_name_classic` sitting in that dropdown, and the scan below
// cannot catch it because the key is built at runtime.
test('every retired machine keeps the name /verify labels it with', () => {
  for (const locale of ['en', 'ka']) {
    for (const id of RETIRED_IDS) {
      assert.ok(STRINGS[locale][`slot_name_${id}`], `${locale}: no name for retired ${id}`);
    }
  }
});

// t() falls back to returning the key itself, so a typo in a page shows
// up as `slot_fact_gird` sitting in the UI rather than as an error. This
// walks the whole frontend and pins every literal key it asks for
// against the table. Computed keys (`t(`slot_name_${id}`)`) are covered
// by the registry test above instead.
test('every string key the frontend asks for exists', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(entry.name)) files.push(full);
    }
  })(path.join(ROOT, 'public'));

  assert.ok(files.length > 20, 'the walk found suspiciously little frontend');
  const missing = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const keys = [
      ...src.matchAll(/(?<![\w$.])t\('([a-z0-9_]+)'\)/g),
      ...src.matchAll(/dataT:\s*'([a-z0-9_]+)'/g),
      ...src.matchAll(/data-tp?="([a-z0-9_]+)"/g),
    ].map((m) => m[1]);
    for (const key of keys) {
      if (!(key in STRINGS.en)) missing.push(`${path.relative(ROOT, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], 'keys used but never defined');
});

test('georgian strings actually contain georgian script', () => {
  let georgian = 0;
  for (const value of Object.values(STRINGS.ka)) {
    if (/[Ⴀ-ჿ]/.test(value)) georgian++;
  }
  // Not every string needs Georgian letters (numbers, RTP…), but the
  // overwhelming majority must have them.
  assert.ok(georgian / Object.keys(STRINGS.ka).length > 0.9);
});
