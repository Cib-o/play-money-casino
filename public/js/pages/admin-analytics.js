import { initShell, el, toastError, onLocaleChange } from '../shell.js';
import { api } from '../api.js';
import { t, fmt, fmtCredits, fmtDate } from '../i18n.js';

const ctx = await initShell({ requireAuth: 'admin' });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let floor = null;
  let report = null;
  let players = [];

  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  // A realized return is a sample mean, and early on a wild one: a
  // handful of lucky rounds can read 300%. Printed bare that looks like a
  // broken paytable, so the margin is printed with it and the figure can
  // be read for what it is — a measurement that has not settled yet.
  function returnText(row) {
    if (row.rtp === null) return '—';
    if (row.rtp_stderr === null) return pct(row.rtp);
    return `${pct(row.rtp)} ± ${pct(row.rtp_stderr)}`;
  }

  function stat(key, value, cls) {
    return el('div', { cls: 'stat' }, [
      el('span', { cls: 'k', dataT: key }),
      el('strong', { cls: cls || '', text: value }),
    ]);
  }

  const signed = (n) => (n >= 0 ? `+${fmtCredits(n)}` : fmtCredits(n));
  const netCls = (n) => (n > 0 ? 'win-text' : n < 0 ? 'lose-text' : '');

  // Inside the sum below the net is an operator and an amount, not a
  // signed number: written as `− 350 -55` the two minus signs are
  // different characters doing different jobs and the line stops reading
  // as arithmetic. This puts the sign where the other operators are.
  const term = (n) => `${n < 0 ? '−' : '+'} ${fmtCredits(Math.abs(n))}`;

  function gameRows(tbody, rows) {
    tbody.textContent = '';
    for (const g of rows) {
      tbody.append(
        el('tr', {}, [
          el('td', { text: t(`game_${g.game}`) }),
          el('td', { cls: 'num', text: fmt(g.rounds) }),
          el('td', { cls: 'num', text: fmtCredits(g.wagered) }),
          el('td', { cls: 'num', text: fmtCredits(g.paid_out) }),
          el('td', { cls: `num ${netCls(g.net)}`, text: signed(g.net) }),
          el('td', { cls: 'num', text: returnText(g) }),
        ]),
      );
    }
  }

  // Credits are granted by an admin and after that only move by being
  // staked, so the figures have to close. When they do this says so
  // plainly; when they do not it names the gap rather than showing a
  // total it cannot account for.
  function reconciliation(node, view) {
    node.textContent = '';
    node.className = `recon ${view.reconciled ? 'ok' : 'bad'}`;
    node.append(
      el('span', { cls: `badge ${view.reconciled ? 'on' : 'off'}`, dataT: view.reconciled ? 'adm_circ_ok' : 'adm_circ_drift' }),
      el('span', {
        cls: 'muted',
        text: view.reconciled
          ? ` ${fmtCredits(view.granted)} − ${fmtCredits(view.removed)} ${term(view.net)} − ${fmtCredits(view.in_flight.staked)} = ${fmtCredits(view.balance ?? view.player.balance)}`
          : ` ${signed(view.drift)}`,
      }),
    );
  }

  function paintFloor() {
    const stats = $('circ-stats');
    stats.textContent = '';
    stats.append(
      stat('adm_circ_balance', fmtCredits(floor.balance)),
      stat('adm_circ_granted', fmtCredits(floor.granted)),
      stat('adm_circ_removed', fmtCredits(floor.removed)),
      stat('adm_circ_inplay', fmtCredits(floor.in_flight.staked)),
      stat('adm_circ_net', signed(floor.net), netCls(floor.net)),
      stat('adm_col_rounds', fmt(floor.rounds)),
    );
    reconciliation($('circ-reconciled'), floor);
    gameRows($('floor-games'), floor.games);
    $('floor-empty').hidden = floor.games.length > 0;
  }

  function paintPlayer() {
    $('player-report').hidden = !report;
    if (!report) return;
    const stats = $('player-stats');
    stats.textContent = '';
    stats.append(
      stat('balance_label', fmtCredits(report.player.balance)),
      stat('adm_circ_granted', fmtCredits(report.granted)),
      stat('adm_circ_removed', fmtCredits(report.removed)),
      stat('adm_col_rounds', fmt(report.rounds)),
      stat('adm_circ_net', signed(report.net), netCls(report.net)),
      stat('adm_col_rtp', returnText(report)),
    );
    reconciliation($('player-reconciled'), report);

    const best = $('player-best');
    best.textContent = report.best_round
      ? `${t('adm_best_round')}: ${signed(report.best_round.net)} · ${t(`game_${report.best_round.game}`)} · ${fmtDate(report.best_round.created_at)}`
      : t('adm_no_rounds');
    gameRows($('player-games'), report.games);
    $('player-empty').hidden = report.games.length > 0;
  }

  async function loadPlayer(id) {
    report = id ? await api(`/api/admin/players/${id}/analytics`) : null;
    paintPlayer();
  }

  function fillPicker() {
    const pick = $('player-pick');
    const keep = pick.value;
    pick.textContent = '';
    for (const p of players) {
      pick.append(el('option', { text: `${p.username} (${fmtCredits(p.balance)})`, attrs: { value: p.id } }));
    }
    if (keep) pick.value = keep;
    $('player-none').hidden = players.length > 0;
    pick.hidden = players.length === 0;
  }

  async function load() {
    [floor, { items: players }] = await Promise.all([
      api('/api/admin/circulation'),
      api('/api/admin/players'),
    ]);
    paintFloor();
    fillPicker();
    await loadPlayer($('player-pick').value);
  }

  $('player-pick').addEventListener('change', (e) => {
    loadPlayer(e.target.value).catch(toastError);
  });

  onLocaleChange(() => {
    if (floor) paintFloor();
    if (report) paintPlayer();
  });

  await load();
}
