import { initShell, state, el, toast, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { sfx } from '../sound.js';
import { cardEl } from '../cards.js';

// ── Live shared blackjack table (client) ──────────────────────────
// The table lives on the server (src/blackjack-table.js) and runs on
// its own; this page just polls a snapshot, draws it, and forwards the
// player's intents. Refreshing resumes polling — the table never
// restarts, and every signed-in player who sits shares it.
//
// Betting UX: tap chips to build your bet, then "Place bet" to commit
// (POST /sit). Clear resets, Leave stands you up. That is the only way
// money is wagered — clicking the felt does nothing.

const CHIP_BASE = [1, 5, 25, 100, 500, 1000];
const POLL_MS = 700;
const PHASE_LABEL = { betting: 'bj_place_bets', acting: 'bj_dealing', dealer: 'bj_dealer_turn', payout: 'bj_next_round' };
const RESULT_KEY = { blackjack: 'bj_blackjack', win: 'bj_win', lose: 'bj_lose', push: 'bj_push' };
const RESULT_CLASS = { blackjack: 'bj', win: 'win', lose: 'lose', push: 'push' };

const ctx = await initShell({ requireAuth: true });
if (ctx) {
  const $ = (id) => document.getElementById(id);
  const canPlay = !!(state.pub && state.pub.games && state.pub.games.blackjack);
  const MIN = state.pub.min_bet;
  const MAX = state.pub.max_bet;

  let pendingBet = 0;
  let clockOffset = 0;
  let lastNonce = -1;
  let lastBalance = null;
  let dealerRevealed = false;
  let dealerSig = '';
  let myResultShown = -1;
  let lastSnap = null;

  // ── seats (built once, updated in place) ────────────────────────
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
      hand, badge, betspot, betAmount,
      el('div', { cls: 'bj-nameplate' }, [avatar, nameEl, totalEl]),
    ]);
    seatsWrap.append(root);
    seatView.push({ root, hand, badge, stack, betAmount, avatar, nameEl, totalEl, count: 0 });
  }
  const dealerHandEl = $('dealer-hand');

  function greedyChips(amount) {
    const out = [];
    let left = amount;
    for (const v of [...CHIP_BASE].reverse()) {
      while (left >= v && out.length < 5) { out.push(v); left -= v; }
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

  // ── chip rack: each chip ADDS its value to the pending bet ───────
  function buildRack() {
    const rack = $('rack');
    const values = CHIP_BASE.filter((v) => v <= MAX);
    for (const v of values.length ? values : [MIN]) {
      const coin = el('span', {
        cls: `chip-coin chip-${v}`,
        text: v >= 1000 ? '1k' : String(v),
        attrs: { role: 'button', tabindex: '0' },
      });
      coin.addEventListener('click', () => addChip(v));
      rack.append(coin);
    }
  }
  function addChip(v) {
    if (!lastSnap || !lastSnap.can_bet || !canPlay) return;
    if (pendingBet + v > MAX) return toast('err_bet_too_large');
    if (pendingBet + v > state.me.balance) return toast('err_insufficient_balance');
    pendingBet += v;
    sfx.chip();
    paintDock(lastSnap);
  }
  buildRack();
  $('limits').textContent = `${t('bj_min')}: ${fmt(MIN)}  ·  ${t('bj_max')}: ${fmt(MAX)}`;

  $('clear-btn').addEventListener('click', () => {
    pendingBet = 0;
    if (lastSnap) paintDock(lastSnap);
  });
  $('sit-btn').addEventListener('click', async () => {
    if (pendingBet < MIN) return toast('err_bet_too_small');
    try {
      await api('/api/game/blackjack/sit', { method: 'POST', body: { bet: pendingBet } });
      sfx.chip();
    } catch (err) {
      toastError(err);
    }
  });
  $('leave-btn').addEventListener('click', async () => {
    try {
      await api('/api/game/blackjack/leave', { method: 'POST' });
      pendingBet = 0;
      if (lastSnap) paintDock(lastSnap);
    } catch (err) {
      toastError(err);
    }
  });
  async function move(m) {
    sfx.button();
    for (const id of ['hit-btn', 'stand-btn', 'double-btn']) $(id).disabled = true;
    try {
      await api('/api/game/blackjack/move', { method: 'POST', body: { move: m } });
    } catch (err) {
      toastError(err);
    }
  }
  $('hit-btn').addEventListener('click', () => move('hit'));
  $('stand-btn').addEventListener('click', () => move('stand'));
  $('double-btn').addEventListener('click', () => move('double'));

  // ── status / dealer / seats ─────────────────────────────────────
  function setStatus(snap) {
    let remaining = null;
    if (snap.phase === 'betting' || snap.phase === 'payout') {
      remaining = Math.max(0, Math.ceil((snap.ends_at - (Date.now() + clockOffset)) / 1000));
    } else if (snap.phase === 'acting' && snap.active_seat === snap.your_seat && snap.your_seat >= 0 && snap.turn_ends_at) {
      remaining = Math.max(0, Math.ceil((snap.turn_ends_at - (Date.now() + clockOffset)) / 1000));
    }
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
    if (!revealed && snap.dealer.cards.length) dealerHandEl.append(cardEl(0, { faceDown: true }));
    if (revealed && !dealerRevealed) sfx.flip();
    else if (growing) sfx.deal();
    dealerRevealed = revealed;
    dealerSig = sig;
    $('dealer-total').textContent = snap.dealer.cards.length ? String(snap.dealer.total) : '';
  }

  function renderSeat(view, seat) {
    view.root.classList.toggle('empty', !seat.occupied);
    view.root.classList.toggle('mine', seat.is_you);
    view.root.classList.toggle('active', seat.active);
    view.nameEl.textContent = !seat.occupied ? t('bj_seat_open') : seat.is_you ? t('bj_your_seat') : seat.name;
    view.avatar.style.setProperty('--hue', seat.occupied ? hueFor(seat.name || String(seat.index)) : 200);
    if (seat.bet > 0) {
      renderChips(view.stack, seat.bet);
      view.betAmount.textContent = fmt(seat.bet);
    } else {
      view.stack.textContent = '';
      view.betAmount.textContent = '';
    }
    if (seat.hand.length < view.count) { view.hand.textContent = ''; view.count = 0; }
    for (let i = view.count; i < seat.hand.length; i++) { view.hand.append(cardEl(seat.hand[i])); sfx.deal(); }
    view.count = seat.hand.length;
    view.totalEl.textContent = seat.hand.length ? String(seat.total) : '';
    if (seat.result) {
      view.badge.className = `bj-seat-badge ${RESULT_CLASS[seat.result]}`;
      view.badge.textContent = t(RESULT_KEY[seat.result]);
    } else {
      view.badge.className = 'bj-seat-badge';
      view.badge.textContent = '';
    }
  }

  // ── the control dock (its own paint, so chip taps update at once)─
  function paintDock(snap) {
    const betting = snap.phase === 'betting' && canPlay;
    const seated = snap.your_seat >= 0;
    const myTurn = snap.phase === 'acting' && snap.active_seat === snap.your_seat && seated;

    $('rack').style.display = betting ? '' : 'none';
    $('sit-btn').hidden = !betting;
    $('clear-btn').hidden = !(betting && pendingBet > 0);
    $('leave-btn').hidden = !(betting && seated);

    $('sit-btn').textContent = pendingBet > 0 ? `${t('bj_bet_btn')} · ${fmt(pendingBet)}` : t('bj_pick_chip');
    $('sit-btn').disabled = pendingBet < MIN;
    $('total-bet').textContent = fmt(pendingBet || (seated ? snap.your_bet : 0));

    const actions = $('actions');
    actions.hidden = !myTurn;
    if (myTurn) {
      const mine = snap.seats[snap.your_seat];
      $('hit-btn').disabled = false;
      $('stand-btn').disabled = false;
      $('double-btn').disabled = mine.hand.length !== 2;
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
      pendingBet = 0; // new round — bet again on purpose, never auto-carried
    }
    setStatus(snap);
    renderDealer(snap);
    for (let i = 0; i < 7; i++) renderSeat(seatView[i], snap.seats[i]);
    paintDock(snap);
    playResultSound(snap);
    if (snap.your_balance !== lastBalance) {
      lastBalance = snap.your_balance;
      updateBalance(snap.your_balance);
    }
    lastSnap = snap;
  }

  async function poll() {
    try {
      render(await api('/api/game/blackjack/table'));
    } catch {
      /* transient — keep polling */
    }
    setTimeout(poll, POLL_MS);
  }
  if (!canPlay) toast('err_game_disabled');
  poll();
}
