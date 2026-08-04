import { STRINGS } from './strings.js';

const FALLBACK = 'ka';
let current = FALLBACK;

export function detectLocale(userLocale) {
  const stored = localStorage.getItem('locale');
  if (stored && STRINGS[stored]) return stored;
  if (userLocale && STRINGS[userLocale]) return userLocale;
  return FALLBACK;
}

export function getLocale() {
  return current;
}

export function setLocale(locale) {
  current = STRINGS[locale] ? locale : FALLBACK;
  localStorage.setItem('locale', current);
  document.documentElement.lang = current;
  applyI18n(document);
}

/** Translate a key in the active locale, falling back across tables. */
export function t(key) {
  const table = STRINGS[current] || STRINGS[FALLBACK];
  if (key in table) return table[key];
  if (key in STRINGS[FALLBACK]) return STRINGS[FALLBACK][key];
  return key;
}

/** Fill every [data-t] textContent and [data-tp] placeholder under root. */
export function applyI18n(root) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll('[data-tp]')) el.placeholder = t(el.dataset.tp);
}

const intlLocale = () => (current === 'ka' ? 'ka-GE' : 'en-US');

/**
 * Hundredths of a credit per credit. Every amount of money the server
 * sends or receives is an integer count of these, so nothing on the
 * wire or in the database is ever a decimal; see the note in src/db.js.
 * A test pins this against the server's copy.
 */
export const CREDIT = 100;

/** Plain integer formatting — round counts, seats, spins. Not money. */
export function fmt(n) {
  return new Intl.NumberFormat(intlLocale()).format(n);
}

/**
 * Money, given in hundredths and printed in credits. Always two
 * decimals: the smallest stake in the house is 0.01, and a win of five
 * hundredths shown as `0.05` next to a win of five credits shown as `5`
 * is one glance away from being read as the same number. Fixed places
 * make the column mean one thing.
 */
export function fmtCredits(units) {
  return new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(units / CREDIT);
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleString(intlLocale(), {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}
