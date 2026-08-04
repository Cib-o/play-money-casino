import { initShell, el, toast, toastError, copyText } from '../shell.js';
import { api } from '../api.js';
import { fmt, fmtCredits, fmtDate, CREDIT } from '../i18n.js';
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

  // Balances travel as hundredths and are typed as credits; these are
  // the only places on the page where the two units meet. The rounding
  // is what keeps a typed 0.07 from arriving as 6.999.
  const toCredits = (units) => (units / CREDIT).toFixed(2);
  const toUnits = (text) => Math.round(Number(text) * CREDIT);

  // ── create player ───────────────────────────────────────────────
  function prefillCreate() {
    $('c-balance').value = toCredits(settings.default_balance);
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
    if ($('c-balance').value !== '') body.balance = toUnits($('c-balance').value);
    body.locale = $('c-locale').value;
    const pw = $('c-password').value.trim();
    if (pw) body.password = pw;
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
          el('td', { cls: 'num', text: fmtCredits(p.balance) }),
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
              el('button', {
                cls: 'btn ghost small', dataT: 'adm_act_delete',
                on: { click: () => askDelete(p) },
              }),
            ]),
          ]),
        ]),
      );
    }
  }

  // ── delete player ──────────────────────────────────────────────
  function askDelete(p) {
    $('delete-who').textContent = `${p.username}${p.display_name ? ` — ${p.display_name}` : ''}`;
    $('delete-confirm').onclick = async () => {
      try {
        await api(`/api/admin/players/${p.id}/delete`, { method: 'POST' });
        $('delete-dialog').close();
        toast('adm_deleted', 'ok');
        await loadPlayers();
      } catch (err) {
        toastError(err);
      }
    };
    $('delete-dialog').showModal();
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
    $('bal-current').textContent = `${p.username} — ${fmtCredits(p.balance)}`;
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
        text: (a.delta >= 0 ? '+' : '') + fmtCredits(a.delta),
      });
      body.append(
        el('tr', {}, [
          el('td', { text: fmtDate(a.created_at) }),
          el('td', { cls: 'num', text: fmtCredits(a.before) }),
          delta,
          el('td', { cls: 'num', text: fmtCredits(a.after) }),
          el('td', { cls: 'muted', text: a.note }),
        ]),
      );
    }
  }

  $('balance-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!currentPlayer) return;
    const body = {};
    if (bSet.value.trim() !== '') body.set = toUnits(bSet.value);
    else if (bDelta.value.trim() !== '') body.delta = toUnits(bDelta.value);
    else return;
    const note = $('b-note').value.trim();
    if (note) body.note = note;
    try {
      const res = await api(`/api/admin/players/${currentPlayer.id}/balance`, {
        method: 'POST',
        body,
      });
      currentPlayer.balance = res.balance;
      $('bal-current').textContent = `${currentPlayer.username} — ${fmtCredits(res.balance)}`;
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
