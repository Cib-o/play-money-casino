import test from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS } from '../public/js/strings.js';
import { FLOOR_IDS } from '../src/games/slot-floor.js';

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

test('georgian strings actually contain georgian script', () => {
  let georgian = 0;
  for (const value of Object.values(STRINGS.ka)) {
    if (/[Ⴀ-ჿ]/.test(value)) georgian++;
  }
  // Not every string needs Georgian letters (numbers, RTP…), but the
  // overwhelming majority must have them.
  assert.ok(georgian / Object.keys(STRINGS.ka).length > 0.9);
});
