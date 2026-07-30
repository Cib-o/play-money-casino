import { initShell, state, el, toast, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { sfx } from '../sound.js';
import { cardEl } from '../cards.js';

// ── Live shared blackjack table (client) ──────────────────────────
// The table lives on the server (see src/blackjack-table.js) and runs
// on its own, so this page is a thin renderer: it polls a snapshot on
// an interval, draws the felt from it, and forwards the player's
// intents (sit / hit / stand / double / leave). Refreshing the page
// just resumes polling — the table never restarts, and every signed-in
// player who sits shares the same table.

const CHIP_BASE = [1, 5, 25, 100, 500, 1000];
const POLL_MS = 700;
const PHASE_LABEL = {
  betting: 'bj_place_bets',
  acting: 'bj_dealing',
  dealer: 'bj_dealer_turn',
  payout: 'bj_next_round',
};
const RESULT_KEY = { blackjack: 'bj_blackjack', win: 'bj_win', lose: 'bj_lose', push: 'bj_push' };
const RESULT_CLASS = { blackjack: 'bj', win: 'win', lose: 'lose', push: 'push' };

const ctx = await initShell({ requireAuth: true });
if (ctx) {
  const $ = (id) => document.getElementById(id);
  const canPlay = !!(state.pub && state.pub.games && state.pub.games.blackjack);

  let chipValue = CHIP_BASE.find((v) => v >= state.pub.min_bet && v <= state.pub.max_bet) || state.pub.min_bet;
  let pendingBet = 0;
  let clockOffset = 0;
  let lastNonce = -1;
  let lastBalance = null;
  let dealerRevealed = false;
  let dealerSig = '';
  let myResultShown = -1;

  // ── build the seven seats once ──────────────────────────────────
  const seatsWrap = $('seats');
  const seatView = [];
  for (let i = 0; i < 7; i++) {
    const hand = el('div', { cls: 'bj-hand' });
    const badge = el('div', { cls: 'bj-seat-badge' });
    const stack = el('div', { cls: 'bj-chip-stack' });
    const betAmount = el('div', { cls: 'bj-bet-amount' });
    const betspot = el('div', { cls: 'bj-betspot' }, [stack]);
    const avatar = el('span', { cls: 'bj-avatar' });
    const nameEl = el('span', { cls: 'bj-seat-name' });
    const totalEl = el('span', { cls: 'bj-seat-total' });
    const root = el('div', { cls: 'bj-seat empty' }, [
      hand,
      badge,
      betspot,
      betAmount,
      el('div', { cls: 'bj-nameplate' }, [avatar, nameEl, totalEl]),
    ]);
    seatsWrap.append(root);
    seatView.push({ root, hand, badge, stack, betAmount, avatar, nameEl, totalEl, count: 0, hue: 200 });
  }

  const dealerHandEl = $('dealer-hand');

  function greedyChips(amount) {
    const out = [];
    let left = amount;
    for (const v of [...CHIP_BASE].reverse()) {
      while (left >= v && out.length < 5) {
        out.push(v);
        left -= v;
      }
    }
    return out;
  }
  function renderChips(stackEl, amount) {
    stackEl.textContent = '';
    for (const v of greedyChips(amount)) {
      stackEl.append(el('span', { cls: `chip-coin chip-${v}`, text: v >= 1000 ? '1k' : String(v) }));
    }
  }
  function hueFor(seed) {
    let h = 0;
    for (const ch of seed || '') h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  // ── rack + controls ─────────────────────────────────────────────
  function buildRack() {
    const rack = $('rack');
    const values = CHIP_BASE.filter((v) => v <= state.pub.max_bet);
    for (const v of (values.length ? values : [state.pub.min_bet])) {
      const coin = el('span', {
        cls: `chip-coin chip-${v}${v === chipValue ? ' selected' : ''}`,
        text: v >= 1000 ? '1k' : String(v),
      });
      coin.addEventListener('click', () => {
        chipValue = v;
        for (const c of rack.children) c.classList.toggle('selected', c === coin);
      });
      rack.append(coin);
    }
  }
  buildRack();
  $('limits').textContent = `${t('bj_min')}: ${fmt(state.pub.min_bet)}  ·  ${t('bj_max')}: ${fmt(state.pub.max_bet)}`;

  function addChip() {
    if (pendingBet + chipValue > state.pub.max_bet) return toast('err_bet_too_large');
    if (pendingBet + chipValue > state.me.balance) return toast('err_insufficient_balance');
    pendingBet += chipValue;
    sfx.chip();
    $('total-bet').textContent = fmt(pendingBet);
  }
  // clicking any seat's bet spot, or the rack "add", adds a chip
  seatsWrap.addEventListener('click', () => {
    if (lastSnap && lastSnap.can_bet && canPlay) addChip();
  });

  $('clear-btn').addEventListener('click', () => {
    pendingBet = 0;
    $('total-bet').textContent = '0';
  });
  $('sit-btn').addEventListener('click', async () => {
    if (pendingBet < state.pub.min_bet) return toast('err_bet_too_small');
    try {
      sfx.chip();
      await api('/api/game/blackjack/sit', { method: 'POST', body: { bet: pendingBet } });
    } catch (err) {
      toastError(err);
    }
  });
  $('leave-btn').addEventListener('click', async () => {
    try {
      await api('/api/game/blackjack/leave', { method: 'POST' });
      pendingBet = 0;
      $('total-bet').textContent = '0';
    } catch (err) {
      toastError(err);
    }
  });
  async function move(m) {
    sfx.button();
    $('hit-btn').disabled = true;
    $('stand-btn').disabled = true;
    $('double-btn').disabled = true;
    try {
      await api('/api/game/blackjack/move', { method: 'POST', body: { move: m } });
    } catch (err) {
      toastError(err);
    }
  }
  $('hit-btn').addEventListener('click', () => move('hit'));
  $('stand-btn').addEventListener('click', () => move('stand'));
  $('double-btn').addEventListener('click', () => move('double'));

  // ── rendering from a snapshot ───────────────────────────────────
  let lastSnap = null;

  function setStatus(snap) {
    const remaining = snap.phase === 'betting' || snap.phase === 'payout'
      ? Math.max(0, Math.ceil((snap.ends_at - (Date.now() + clockOffset)) / 1000))
      : (snap.active_seat >= 0 && snap.active_seat === snap.your_seat && snap.turn_ends_at
          ? Math.max(0, Math.ceil((snap.turn_ends_at - (Date.now() + clockOffset)) / 1000))
          : null);
    let key = PHASE_LABEL[snap.phase] || '';
    if (snap.phase === 'acting' && snap.active_seat === snap.your_seat && snap.your_seat >= 0) key = 'bj_your_turn';
    $('status').classList.remove('hidden');
    $('status-text').textContent = t(key);
    $('status-count').textContent = remaining === null ? '' : String(remaining);
  }

  function renderDealer(snap) {
    const revealed = snap.dealer.revealed;
    const sig = `${revealed}:${snap.dealer.cards.join(',')}`;
    if (sig === dealerSig) return;
    const growing = snap.dealer.cards.length > (lastSnap ? lastSnap.dealer.cards.length : 0);
    dealerHandEl.textContent = '';
    for (const c of snap.dealer.cards) dealerHandEl.append(cardEl(c));
    // during play the hole is hidden: show a face-down card after the up-card
    if (!revealed && snap.dealer.cards.length) dealerHandEl.append(cardEl(0, { faceDown: true }));
    if (revealed && !dealerRevealed) sfx.flip();
    else if (growing) sfx.deal();
    dealerRevealed = revealed;
    dealerSig = sig;
    $('dealer-total').textContent = snap.dealer.cards.length ? String(snap.dealer.total) : '';
  }

  function renderSeat(view, seat, snap) {
    const occupied = seat.occupied;
    view.root.classList.toggle('empty', !occupied);
    view.root.classList.toggle('mine', seat.is_you);
    view.root.classList.toggle('active', seat.active);
    // name
    view.nameEl.textContent = !occupied ? t('bj_seat_open') : seat.is_you ? t('bj_you') : seat.name;
    const hue = occupied ? hueFor(seat.name || String(seat.index)) : 200;
    view.avatar.style.setProperty('--hue', hue);
    // bet chips
    if (seat.bet > 0) {
      renderChips(view.stack, seat.bet);
      view.betAmount.textContent = fmt(seat.bet);
    } else {
      view.stack.textContent = '';
      view.betAmount.textContent = '';
    }
    // hand — append only new cards; clear when a new round resets it
    if (seat.hand.length < view.count) {
      view.hand.textContent = '';
      view.count = 0;
    }
    for (let i = view.count; i < seat.hand.length; i++) {
      view.hand.append(cardEl(seat.hand[i]));
      sfx.deal();
    }
    view.count = seat.hand.length;
    view.totalEl.textContent = seat.hand.length ? String(seat.total) : '';
    // result badge
    if (seat.result) {
      view.badge.className = `bj-seat-badge ${RESULT_CLASS[seat.result]}`;
      view.badge.textContent = t(RESULT_KEY[seat.result]);
    } else {
      view.badge.className = 'bj-seat-badge';
      view.badge.textContent = '';
    }
  }

  function renderControls(snap) {
    const betting = snap.phase === 'betting' && canPlay;
    const seated = snap.your_seat >= 0;
    const myTurn = snap.phase === 'acting' && snap.active_seat === snap.your_seat && seated;

    $('rack').style.display = betting ? '' : 'none';
    $('sit-btn').hidden = !betting;
    $('clear-btn').hidden = !betting;
    $('leave-btn').hidden = !(betting && seated);
    $('sit-btn').textContent = seated ? t('bj_place_bets') : t('bj_sit_prompt');

    const actions = $('actions');
    actions.hidden = !myTurn;
    if (myTurn) {
      const mySeat = snap.seats[snap.your_seat];
      $('hit-btn').disabled = false;
      $('stand-btn').disabled = false;
      $('double-btn').disabled = !(mySeat.hand.length === 2);
    }
    if (!betting && pendingBet !== 0) {
      pendingBet = 0;
      $('total-bet').textContent = '0';
    }
  }

  function playResultSound(snap) {
    if (snap.phase !== 'payout' || snap.your_seat < 0) return;
    if (snap.nonce === myResultShown) return;
    const r = snap.seats[snap.your_seat].result;
    if (!r) return;
    myResultShown = snap.nonce;
    if (r === 'blackjack') sfx.big();
    else if (r === 'win') sfx.win();
    else if (r === 'lose') sfx.lose();
    else sfx.push();
  }

  function render(snap) {
    clockOffset = snap.now - Date.now();
    if (snap.nonce !== lastNonce) {
      lastNonce = snap.nonce;
      dealerRevealed = false;
      dealerSig = '';
    }
    setStatus(snap);
    renderDealer(snap);
    for (let i = 0; i < 7; i++) renderSeat(seatView[i], snap.seats[i], snap);
    renderControls(snap);
    playResultSound(snap);
    if (snap.your_balance !== lastBalance) {
      lastBalance = snap.your_balance;
      updateBalance(snap.your_balance);
    }
    $('shoe-count').textContent = '';
    lastSnap = snap;
  }

  // ── poll loop ───────────────────────────────────────────────────
  async function poll() {
    try {
      const snap = await api('/api/game/blackjack/table');
      render(snap);
    } catch (err) {
      // transient network errors are ignored; keep polling
    }
    setTimeout(poll, POLL_MS);
  }
  if (!canPlay) toast('err_game_disabled');
  poll();
}
