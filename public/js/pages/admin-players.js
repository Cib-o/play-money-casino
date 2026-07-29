import { initShell, el, toast, toastError, copyText } from '../shell.js';
import { api } from '../api.js';
import { t, fmt, fmtDate } from '../i18n.js';
import { onLocaleChange } from '../shell.js';
import { STRINGS } from '../strings.js';

const ctx = await initShell({ requireAuth: 'admin' });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let settings = await api('/api/admin/settings');
  let players = [];
  let currentPlayer = null;

  // Dialog close buttons.
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }

  // ── create player ───────────────────────────────────────────────
  function prefillCreate() {
    $('c-balance').value = settings.default_balance;
    $('c-locale').value = settings.default_locale;
  }
  prefillCreate();

  // Credential block in the *player's* language, ready to paste.
  function credsBlock(username, password, locale) {
    const s = STRINGS[locale] || STRINGS.ka;
    return (
      `${s.login_url_label}: ${location.origin}/login\n` +
      `${s.login_username}: ${username}\n` +
      `${s.login_password}: ${password}`
    );
  }

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = { username: $('c-username').value.trim() };
    const display = $('c-display').value.trim();
    if (display) body.display_name = display;
    if ($('c-balance').value !== '') body.balance = Number($('c-balance').value);
    body.locale = $('c-locale').value;
    try {
      const res = await api('/api/admin/players', { method: 'POST', body });
      const block = credsBlock(res.user.username, res.password, res.user.locale);
      $('creds-block').textContent = block;
      $('creds-copy').onclick = () => copyText(block);
      $('creds-dialog').showModal();
      $('create-form').reset();
      prefillCreate();
      await loadPlayers();
    } catch (err) {
      toastError(err);
    }
  });

  // ── players table ───────────────────────────────────────────────
  async function loadPlayers() {
    const search = $('search').value.trim();
    const res = await api(
      '/api/admin/players' + (search ? `?search=${encodeURIComponent(search)}` : ''),
    );
    players = res.items;
    renderPlayers();
  }

  function renderPlayers() {
    const body = $('players-body');
    body.textContent = '';
    $('players-empty').hidden = players.length > 0;
    for (const p of players) {
      body.append(
        el('tr', {}, [
          el('td', { text: p.username }),
          el('td', { text: p.display_name }),
          el('td', { cls: 'num', text: fmt(p.balance) }),
          el('td', { cls: 'num', text: fmt(p.rounds) }),
          el('td', {}, [
            el('span', {
              cls: `badge ${p.is_active ? 'on' : 'off'}`,
              dataT: p.is_active ? 'adm_active' : 'adm_disabled',
            }),
          ]),
          el('td', {}, [
            el('div', { cls: 'actions-cell' }, [
              el('button', {
                cls: 'btn ghost small', dataT: 'balance_label',
                on: { click: () => openBalance(p) },
              }),
              el('button', {
                cls: 'btn ghost small', dataT: 'adm_act_reset',
                on: { click: () => resetPassword(p) },
              }),
              el('button', {
                cls: `btn small ${p.is_active ? 'danger' : 'violet'}`,
                dataT: p.is_active ? 'adm_act_disable' : 'adm_act_enable',
                on: { click: () => toggleActive(p) },
              }),
            ]),
          ]),
        ]),
      );
    }
  }

  let searchTimer;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPlayers().catch(toastError), 250);
  });

  // ── balance dialog ──────────────────────────────────────────────
  const bSet = $('b-set');
  const bDelta = $('b-delta');
  // Typing in one input clears the other, so it is never ambiguous
  // which of the two will apply.
  bSet.addEventListener('input', () => {
    if (bSet.value !== '') bDelta.value = '';
  });
  bDelta.addEventListener('input', () => {
    if (bDelta.value !== '') bSet.value = '';
  });

  async function openBalance(p) {
    currentPlayer = p;
    $('bal-current').textContent = `${p.username} — ${fmt(p.balance)}`;
    bSet.value = '';
    bDelta.value = '';
    $('b-note').value = '';
    await loadAdjustments(p.id);
    $('balance-dialog').showModal();
  }

  async function loadAdjustments(id) {
    const res = await api(`/api/admin/players/${id}/adjustments`);
    const body = $('adj-body');
    body.textContent = '';
    for (const a of res.items) {
      const delta = el('td', {
        cls: `num ${a.delta >= 0 ? 'win-text' : 'lose-text'}`,
        text: (a.delta >= 0 ? '+' : '') + fmt(a.delta),
      });
      body.append(
        el('tr', {}, [
          el('td', { text: fmtDate(a.created_at) }),
          el('td', { cls: 'num', text: fmt(a.before) }),
          delta,
          el('td', { cls: 'num', text: fmt(a.after) }),
          el('td', { cls: 'muted', text: a.note }),
        ]),
      );
    }
  }

  $('balance-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentPlayer) return;
    const body = {};
    if (bSet.value.trim() !== '') body.set = Number(bSet.value);
    else if (bDelta.value.trim() !== '') body.delta = Number(bDelta.value);
    else return;
    const note = $('b-note').value.trim();
    if (note) body.note = note;
    try {
      const res = await api(`/api/admin/players/${currentPlayer.id}/balance`, {
        method: 'POST',
        body,
      });
      currentPlayer.balance = res.balance;
      $('bal-current').textContent = `${currentPlayer.username} — ${fmt(res.balance)}`;
      bSet.value = '';
      bDelta.value = '';
      $('b-note').value = '';
      toast('adm_saved', 'ok');
      await loadAdjustments(currentPlayer.id);
      await loadPlayers();
    } catch (err) {
      toastError(err);
    }
  });

  // ── row actions ─────────────────────────────────────────────────
  async function resetPassword(p) {
    try {
      const res = await api(`/api/admin/players/${p.id}/reset-password`, { method: 'POST' });
      const block = credsBlock(res.username, res.password, p.locale);
      $('reset-block').textContent = block;
      $('reset-copy').onclick = () => copyText(block);
      $('reset-dialog').showModal();
    } catch (err) {
      toastError(err);
    }
  }

  async function toggleActive(p) {
    try {
      await api(`/api/admin/players/${p.id}/active`, {
        method: 'POST',
        body: { is_active: !p.is_active },
      });
      await loadPlayers();
    } catch (err) {
      toastError(err);
    }
  }

  onLocaleChange(() => {
    renderPlayers();
    if (currentPlayer) loadAdjustments(currentPlayer.id).catch(() => {});
  });

  await loadPlayers();
}
