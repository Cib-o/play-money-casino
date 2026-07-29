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

export function fmt(n) {
  return new Intl.NumberFormat(intlLocale()).format(n);
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleString(intlLocale(), {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}
