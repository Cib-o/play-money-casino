import { initShell, state, el, toast, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { sfx } from '../sound.js';
import { cardEl } from '../cards.js';

// ── Live shared blackjack table (client) ──────────────────────────
// The table lives on the server (src/blackjack-table.js) and runs on
// its own; this page polls a snapshot, draws it, and forwards intents.
//
// Flow: click an empty seat to sit, select a chip in the rack, then
// tap your own seat to drop that chip — each tap raises your bet. Clear
// resets it, Leave stands you up from your seat. Every POST returns the
// fresh snapshot, so the table reacts immediately between polls.

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
  const myName = (state.me.display_name || '').trim() || state.me.username;

  let selectedChip = CHIP_BASE.find((v) => v >= MIN && v <= MAX) || MIN;
  let clockOffset = 0;
  let lastNonce = -1;
  let lastBalance = null;
  let dealerRevealed = false;
  let dealerSig = '';
  let myResultShown = -1;
  let lastTickSecond = -1;
  let lastSnap = null;
  let busy = false;

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
    const root = el('div', { cls: 'bj-seat empty', attrs: { 'data-index': String(i) } }, [
      hand, badge, betspot, betAmount,
      el('div', { cls: 'bj-nameplate' }, [avatar, nameEl, totalEl]),
    ]);
    seatsWrap.append(root);
    seatView.push({ root, hand, badge, stack, betAmount, avatar, nameEl, totalEl, count: 0 });
  }
  const dealerHandEl = $('dealer-hand');

  // a persistent hint line in the dock
  const hintEl = el('div', { cls: 'bj-hint' });
  $('rack').parentElement.insertBefore(hintEl, $('rack'));

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

  // ── chip rack: click selects the active chip ────────────────────
  function buildRack() {
    const rack = $('rack');
    const values = CHIP_BASE.filter((v) => v <= MAX);
    for (const v of values.length ? values : [MIN]) {
      const coin = el('span', {
        cls: `chip-coin chip-${v}${v === selectedChip ? ' selected' : ''}`,
        text: v >= 1000 ? '1k' : String(v),
        attrs: { role: 'button', tabindex: '0' },
      });
      coin.addEventListener('click', () => {
        selectedChip = v;
        for (const c of rack.children) c.classList.toggle('selected', c === coin);
        sfx.button();
      });
      rack.append(coin);
    }
  }
  buildRack();
  $('limits').textContent = `${t('bj_min')}: ${fmt(MIN)}  ·  ${t('bj_max')}: ${fmt(MAX)}`;

  // Fullscreen toggle — offered only where the API exists (not iOS
  // Safari, which is why the rotate-to-play gate is the real fix).
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  const fsBtn = $('fs-btn');
  if (fsBtn && document.documentElement.requestFullscreen) {
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', () => {
      sfx.button();
      toggleFullscreen();
    });
  }

  // Floating controls shown when the header is hidden on landscape
  // phones: a menu button that opens the side drawer (so the player can
  // still leave for the lobby) and a fullscreen button where supported.
  const bjMenu = $('bj-menu');
  if (bjMenu) {
    bjMenu.addEventListener('click', () => document.getElementById('burger-btn')?.click());
  }
  const bjFs2 = $('bj-fs2');
  if (bjFs2) {
    if (document.documentElement.requestFullscreen) bjFs2.addEventListener('click', toggleFullscreen);
    else bjFs2.remove(); // no fullscreen API (e.g. iOS Safari)
  }

  // Scale the whole table to fill the window without scrolling, on any
  // device. offsetWidth/offsetHeight are the pre-transform layout size,
  // so measuring while a scale is applied is stable.
  const fitEl = $('bj-fit');
  const stageEl = document.querySelector('.bj-stage');
  function fitStage() {
    if (!fitEl || !stageEl || stageEl.offsetParent === null) return;
    const natW = stageEl.offsetWidth;
    const natH = stageEl.offsetHeight;
    const availW = fitEl.clientWidth;
    const availH = fitEl.clientHeight;
    if (!natW || !natH || !availW || !availH) return;
    // never clamp below the fit: the controls must always stay on screen
    const scale = Math.min(availW / natW, availH / natH, 2.2);
    if (scale <= 0) return;
    stageEl.style.transform = `scale(${scale})`;
  }
  window.addEventListener('resize', fitStage);
  window.addEventListener('orientationchange', () => setTimeout(fitStage, 200));
  document.addEventListener('fullscreenchange', () => setTimeout(fitStage, 120));
  fitStage();

  // ── seat interaction: sit on an empty seat, bet on your own ──────
  async function post(path, body) {
    if (busy) return;
    busy = true;
    try {
      render(await api(path, body ? { method: 'POST', body } : { method: 'POST' }));
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }
  seatsWrap.addEventListener('click', (e) => {
    if (!lastSnap || lastSnap.phase !== 'betting' || !canPlay) return;
    const seatEl = e.target.closest('.bj-seat');
    if (!seatEl) return;
    const idx = Number(seatEl.dataset.index);
    const seat = lastSnap.seats[idx];
    if (lastSnap.your_seat < 0) {
      if (!seat.occupied) post('/api/game/blackjack/sit', { seat: idx });
      else toast('err_seat_taken');
    } else if (idx === lastSnap.your_seat) {
      const next = seat.bet + selectedChip;
      if (next > MAX) return toast('err_bet_too_large');
      if (next > state.me.balance) return toast('err_insufficient_balance');
      sfx.chip();
      post('/api/game/blackjack/bet', { amount: next });
    }
  });

  $('clear-btn').addEventListener('click', () => post('/api/game/blackjack/bet', { amount: 0 }));
  $('leave-btn').addEventListener('click', () => post('/api/game/blackjack/leave'));
  async function move(m) {
    sfx.button();
    for (const id of ['hit-btn', 'stand-btn', 'double-btn']) $(id).disabled = true;
    try {
      render(await api('/api/game/blackjack/move', { method: 'POST', body: { move: m } }));
    } catch (err) {
      toastError(err);
    }
  }
  $('hit-btn').addEventListener('click', () => move('hit'));
  $('stand-btn').addEventListener('click', () => move('stand'));
  $('double-btn').addEventListener('click', () => move('double'));

  // ── status / timer ──────────────────────────────────────────────
  function remainingSeconds(snap) {
    if (snap.phase === 'betting' || snap.phase === 'payout') {
      return Math.max(0, Math.ceil((snap.ends_at - (Date.now() + clockOffset)) / 1000));
    }
    if (snap.phase === 'acting' && snap.active_seat === snap.your_seat && snap.your_seat >= 0 && snap.turn_ends_at) {
      return Math.max(0, Math.ceil((snap.turn_ends_at - (Date.now() + clockOffset)) / 1000));
    }
    return null;
  }
  function setStatus(snap) {
    const remaining = remainingSeconds(snap);
    let key = PHASE_LABEL[snap.phase] || '';
    const myTurn = snap.phase === 'acting' && snap.active_seat === snap.your_seat && snap.your_seat >= 0;
    if (myTurn) key = 'bj_your_turn';
    $('status-text').textContent = t(key);
    $('status-count').textContent = remaining === null ? '' : String(remaining);
    const urgent = remaining !== null && remaining <= 3;
    $('status').classList.toggle('urgent', urgent);
    $('status').classList.toggle('has-count', remaining !== null);

    // ticking sound as a betting window or your turn runs out
    const timed = snap.phase === 'betting' || myTurn;
    if (timed && remaining !== null && remaining <= 5 && remaining > 0) {
      if (remaining !== lastTickSecond) sfx.tick(remaining <= 2);
    }
    lastTickSecond = remaining;
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
    // your own seat shows your username; everyone else is masked
    view.nameEl.textContent = !seat.occupied ? t('bj_seat_open') : seat.is_you ? myName : seat.name;
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

  function paintDock(snap) {
    const betting = snap.phase === 'betting' && canPlay;
    const seated = snap.your_seat >= 0;
    const myBet = seated ? snap.seats[snap.your_seat].bet : 0;
    const myTurn = snap.phase === 'acting' && snap.active_seat === snap.your_seat && seated;

    $('rack').style.display = betting && seated ? 'flex' : 'none';
    $('clear-btn').hidden = !(betting && seated && myBet > 0);
    $('leave-btn').hidden = !(betting && seated);
    $('total-bet').textContent = fmt(myBet);

    if (betting && !seated) hintEl.textContent = t('bj_choose_seat');
    else if (betting && seated && myBet === 0) hintEl.textContent = t('bj_place_hint');
    else hintEl.textContent = '';

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
    fitStage(); // re-fit: card/dock changes can alter the table height
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
