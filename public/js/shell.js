import { api, ApiError } from './api.js';
import { applyI18n, detectLocale, getLocale, setLocale, t, fmt } from './i18n.js';
import { sfx } from './sound.js';

export const state = { me: null, pub: null };

const localeListeners = [];
export function onLocaleChange(fn) {
  localeListeners.push(fn);
}

// ── tiny DOM builder (textContent only — no HTML from data) ───────
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.cls) node.className = props.cls;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.dataT) {
    node.dataset.t = props.dataT;
    node.textContent = t(props.dataT);
  }
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, v);
  if (props.on) for (const [ev, fn] of Object.entries(props.on)) node.addEventListener(ev, fn);
  for (const child of children) node.append(child);
  return node;
}

// ── toasts ────────────────────────────────────────────────────────
export function toast(key, kind = 'error') {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = el('div', { attrs: { id: 'toast-root' } });
    document.body.append(root);
  }
  const item = el('div', { cls: `toast${kind === 'ok' ? ' ok' : ''}`, text: t(key) });
  root.append(item);
  setTimeout(() => item.remove(), 4000);
}

export function toastError(err) {
  toast(err && err.code ? err.code : 'err_generic');
}

// ── clipboard ─────────────────────────────────────────────────────
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { text });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('copied', 'ok');
}

// ── header / footer ───────────────────────────────────────────────
const HEADER_HTML = `
<div class="shell-header container">
  <button type="button" class="burger" id="burger-btn" aria-label="Menu">☰</button>
  <a class="brand" href="/"><span class="spark">◆</span> <span id="brand-name"></span></a>
  <nav class="main-nav" id="main-nav"></nav>
  <div class="header-right">
    <div class="balance-chip" id="balance-chip" hidden>
      <span data-t="balance_label"></span><strong class="num" id="balance-value"></strong>
    </div>
    <button type="button" class="btn ghost small icon-btn" id="sfx-btn">🔊</button>
    <div class="lang-switch" role="group">
      <button type="button" data-lang="ka">ქარ</button>
      <button type="button" data-lang="en">ENG</button>
    </div>
    <button type="button" class="btn ghost small" id="logout-btn" data-t="nav_logout" hidden></button>
  </div>
</div>`;

const FOOTER_HTML = `
<div class="container footer-inner">
  <p class="notice" data-t="footer_notice"></p>
  <p class="links"><a href="/fairness" data-t="nav_fairness"></a><a href="/verify" data-t="nav_verify"></a></p>
</div>`;

function navItems() {
  if (!state.me) return [];
  if (state.me.role === 'admin') {
    return [
      ['/admin', 'nav_admin_players'],
      ['/admin/audit', 'nav_admin_audit'],
      ['/admin/settings', 'nav_admin_settings'],
      ['/', 'nav_lobby'],
    ];
  }
  return [
    ['/', 'nav_lobby'],
    ['/history', 'nav_history'],
    ['/fairness', 'nav_fairness'],
    ['/profile', 'nav_profile'],
  ];
}

function renderChrome() {
  const header = document.getElementById('app-header');
  if (header) {
    header.innerHTML = HEADER_HTML; // constant markup, translated below
    document.getElementById('brand-name').textContent = state.pub ? state.pub.site_name : '';
    const brand = header.querySelector('.brand');
    if (state.me && state.me.role === 'admin') brand.setAttribute('href', '/admin');

    const nav = document.getElementById('main-nav');
    for (const [href, key] of navItems()) {
      const link = el('a', { dataT: key, attrs: { href } });
      if (location.pathname === href) link.className = 'active';
      nav.append(link);
    }

    if (state.me && state.me.role === 'player') {
      document.getElementById('balance-chip').hidden = false;
      document.getElementById('balance-value').textContent = fmt(state.me.balance);
    }

    for (const btn of header.querySelectorAll('.lang-switch button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === getLocale()));
      btn.addEventListener('click', () => switchLocale(btn.dataset.lang));
    }

    const sfxBtn = document.getElementById('sfx-btn');
    if (sfxBtn) {
      const paint = () => {
        sfxBtn.textContent = sfx.isOn() ? '🔊' : '🔇';
        sfxBtn.title = t('sound');
        sfxBtn.setAttribute('aria-label', t('sound'));
      };
      paint();
      sfxBtn.addEventListener('click', () => {
        sfx.toggle();
        paint();
      });
    }

    const logout = document.getElementById('logout-btn');
    if (state.me) {
      logout.hidden = false;
      logout.addEventListener('click', doLogout);
    }

    // burger + side drawer for phones and tablets
    document.body.classList.toggle('has-menu', !!state.me);
    const burger = document.getElementById('burger-btn');
    if (burger) burger.addEventListener('click', openDrawer);
    buildDrawer();
  }

  const footer = document.getElementById('app-footer');
  if (footer) footer.innerHTML = FOOTER_HTML;
}

async function doLogout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}

function openDrawer() {
  document.getElementById('drawer')?.classList.add('open');
  document.getElementById('drawer-backdrop')?.classList.add('show');
  document.body.classList.add('no-scroll');
}
function closeDrawer() {
  document.getElementById('drawer')?.classList.remove('open');
  document.getElementById('drawer-backdrop')?.classList.remove('show');
  document.body.classList.remove('no-scroll');
}

// A slide-in menu that mirrors the header's navigation and controls.
// Rebuilt on each chrome render; the same links carry data-t so a
// language switch relabels them in place.
function buildDrawer() {
  document.getElementById('drawer-root')?.remove();
  if (!state.me) return; // no menu before sign-in

  const nav = el('nav', { cls: 'drawer-nav' });
  for (const [href, key] of navItems()) {
    const link = el('a', { dataT: key, attrs: { href }, on: { click: closeDrawer } });
    if (location.pathname === href) link.className = 'active';
    nav.append(link);
  }

  const langWrap = el('div', { cls: 'lang-switch', attrs: { role: 'group' } });
  for (const lang of ['ka', 'en']) {
    const b = el('button', {
      text: lang === 'ka' ? 'ქარ' : 'ENG',
      attrs: { type: 'button', 'data-lang': lang },
      on: { click: () => switchLocale(lang) },
    });
    b.setAttribute('aria-pressed', String(lang === getLocale()));
    langWrap.append(b);
  }

  const sfxBtn = el('button', { cls: 'btn ghost small' });
  const paint = () => {
    sfxBtn.textContent = sfx.isOn() ? `🔊 ${t('sound')}` : `🔇 ${t('sound')}`;
  };
  paint();
  sfxBtn.addEventListener('click', () => {
    sfx.toggle();
    paint();
    const h = document.getElementById('sfx-btn');
    if (h) h.textContent = sfx.isOn() ? '🔊' : '🔇';
  });

  const panel = el('aside', { cls: 'drawer', attrs: { id: 'drawer', 'aria-hidden': 'true' } }, [
    el('div', { cls: 'drawer-head' }, [
      el('span', { cls: 'brand', text: state.pub ? state.pub.site_name : '' }),
      el('button', { cls: 'btn ghost small icon-btn', text: '✕', on: { click: closeDrawer } }),
    ]),
    nav,
    el('div', { cls: 'drawer-section' }, [langWrap, sfxBtn]),
    el('button', { cls: 'btn ghost drawer-logout', dataT: 'nav_logout', on: { click: doLogout } }),
  ]);

  const backdrop = el('div', { cls: 'drawer-backdrop', attrs: { id: 'drawer-backdrop' }, on: { click: closeDrawer } });
  const root = el('div', { attrs: { id: 'drawer-root' } }, [backdrop, panel]);
  document.body.append(root);
  applyI18n(root);
}

function switchLocale(locale) {
  setLocale(locale);
  for (const btn of document.querySelectorAll('.lang-switch button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === locale));
  }
  if (state.me) {
    state.me.balance !== undefined &&
      (document.getElementById('balance-value').textContent = fmt(state.me.balance));
    api('/api/profile', { method: 'POST', body: { locale } }).catch(() => {});
  }
  for (const fn of localeListeners) fn(locale);
}

export function updateBalance(balance) {
  if (!state.me) return;
  state.me.balance = balance;
  const chip = document.getElementById('balance-chip');
  const value = document.getElementById('balance-value');
  if (!chip || !value) return;
  value.textContent = fmt(balance);
  chip.classList.remove('bump');
  void chip.offsetWidth; // restart the animation
  chip.classList.add('bump');
}

/**
 * Boot a page: fetch session + public config, enforce access, render
 * header/footer, apply translations. Returns null when redirecting.
 *   requireAuth: true  — any signed-in user
 *   requireAuth: 'admin' — admins only
 */
export async function initShell({ requireAuth = false } = {}) {
  const [pub, me] = await Promise.all([
    api('/api/public').catch(() => null),
    api('/api/me').then((r) => r.user).catch((err) => {
      if (err instanceof ApiError && err.status === 401) return null;
      return null;
    }),
  ]);
  state.pub = pub;
  state.me = me;

  if (requireAuth && !me) {
    location.href = '/login';
    return null;
  }
  if (requireAuth === 'admin' && me.role !== 'admin') {
    location.href = '/';
    return null;
  }

  setLocale(detectLocale(me ? me.locale : pub ? pub.default_locale : undefined));
  renderChrome();
  applyI18n(document);
  return state;
}
