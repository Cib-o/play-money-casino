import { initShell, state, el, toast, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { sfx } from '../sound.js';
import {
  cardEl,
  revealCard,
  handTotal,
  isBlackjack,
  makeShoe,
  botAction,
  dealerDraw,
  maskedName,
  avatarHue,
  randInt,
  pick,
} from '../cards.js';

// ── live blackjack table ──────────────────────────────────────────
// A continuously running table: bots take seats and play purely for
// atmosphere (cosmetic cards from a client shoe, no money, no bearing
// on anything), while the signed-in player may join any round with a
// real bet. When they join, their hand and the dealer's hand come from
// the verifiable commit-reveal server engine (unchanged) and settle
// against their real balance — so their round still shows up in
// history and reproduces on /verify. Bots simply resolve against the
// same dealer hand for show.

const SEAT_COUNT = 7;
const PLAYER_SEAT = 3;
const BET_SECONDS = 12;
const TURN_SECONDS = 20;
const SHOE_DECKS = 6;
const RESHUFFLE_AT = 78;
const CHIP_BASE = [1, 5, 25, 100, 500, 1000];

const ctx = await initShell({ requireAuth: true });
if (ctx) {
  const $ = (id) => document.getElementById(id);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const canJoin = !!(state.pub && state.pub.games && state.pub.games.blackjack);
  const minBet = state.pub.min_bet;
  const maxBet = state.pub.max_bet;

  let shoe = [];
  let chipValue = CHIP_BASE.find((v) => v >= minBet && v <= maxBet) || minBet;
  let pendingBet = 0;
  let phase = 'idle';
  let canBet = false;
  let playerChoiceResolver = null;
  let turnTimer = null;

  // ── shoe ────────────────────────────────────────────────────────
  const shoeEl = $('shoe');
  function updateShoeCount() {
    $('shoe-count').textContent = String(shoe.length);
  }
  async function ensureShoe() {
    if (shoe.length >= RESHUFFLE_AT) return;
    shoeEl.classList.add('shuffling');
    setStatus('bj_shuffling');
    sfx.shuffle();
    await delay(900);
    shoe = makeShoe(SHOE_DECKS);
    shoeEl.classList.remove('shuffling');
    updateShoeCount();
  }
  function drawCosmetic() {
    if (shoe.length === 0) shoe = makeShoe(SHOE_DECKS);
    const card = shoe.pop();
    updateShoeCount();
    return card;
  }

  // ── seats ───────────────────────────────────────────────────────
  const seats = [];
  const seatsWrap = $('seats');
  for (let i = 0; i < SEAT_COUNT; i++) {
    const mine = i === PLAYER_SEAT;
    const hand = el('div', { cls: 'bj-hand' });
    const badge = el('div', { cls: 'bj-seat-badge' });
    const stack = el('div', { cls: 'bj-chip-stack' });
    const betAmount = el('div', { cls: 'bj-bet-amount' });
    const betspot = el('div', { cls: 'bj-betspot' }, [stack]);
    const avatar = el('span', { cls: 'bj-avatar' });
    const nameEl = el('span', { cls: 'bj-seat-name' });
    const totalEl = el('span', { cls: 'bj-seat-total' });
    const nameplate = el('div', { cls: 'bj-nameplate' }, [avatar, nameEl, totalEl]);
    const root = el('div', { cls: `bj-seat${mine ? ' mine' : ' empty'}` }, [
      hand,
      badge,
      betspot,
      betAmount,
      nameplate,
    ]);
    if (mine) {
      betspot.addEventListener('click', () => placeChip());
    }
    seatsWrap.append(root);
    seats.push({
      index: i,
      mine,
      kind: mine ? 'mine' : 'empty',
      name: '',
      hue: 200,
      bet: 0,
      hand: [],
      result: null,
      dom: { root, hand, badge, stack, betAmount, avatar, nameEl, totalEl, betspot },
    });
  }
  const playerSeat = seats[PLAYER_SEAT];

  function clearSeatVisual(seat) {
    seat.hand = [];
    seat.result = null;
    seat.dom.hand.textContent = '';
    seat.dom.badge.className = 'bj-seat-badge';
    seat.dom.badge.textContent = '';
    seat.dom.totalEl.textContent = '';
    seat.dom.stack.textContent = '';
    seat.dom.betAmount.textContent = '';
    seat.dom.root.classList.remove('active');
  }

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
  function renderChipStack(stackEl, amount) {
    stackEl.textContent = '';
    for (const v of greedyChips(amount)) {
      stackEl.append(el('span', { cls: `chip-coin chip-${v}`, text: v >= 1000 ? '1k' : String(v) }));
    }
  }

  // ── bot occupancy ───────────────────────────────────────────────
  function assignBots() {
    for (const seat of seats) {
      if (seat.mine) continue;
      if (seat.kind === 'empty') {
        if (randInt(100) < 55) {
          seat.kind = 'bot';
          seat.name = maskedName();
          seat.hue = avatarHue();
        }
      } else if (seat.kind === 'bot' && randInt(100) < 18) {
        seat.kind = 'empty';
        seat.name = '';
      }
      const occupied = seat.kind === 'bot';
      seat.dom.root.classList.toggle('empty', !occupied);
      seat.dom.avatar.style.setProperty('--hue', seat.hue);
      seat.dom.nameEl.textContent = occupied ? seat.name : t('bj_seat_open');
    }
  }

  // ── status banner ───────────────────────────────────────────────
  function setStatus(key, count) {
    $('status').classList.remove('hidden');
    $('status-text').textContent = key ? t(key) : '';
    $('status-count').textContent = count === undefined ? '' : String(count);
  }

  // ── dealer rendering ────────────────────────────────────────────
  const dealerHandEl = $('dealer-hand');
  let dealerHoleEl = null;
  function setDealerTotal(cards) {
    $('dealer-total').textContent = cards.length ? String(handTotal(cards).total) : '';
  }

  // ── betting phase ───────────────────────────────────────────────
  function placeChip() {
    if (!canBet || !canJoin) return;
    if (pendingBet + chipValue > maxBet) return toast('err_bet_too_large');
    if (pendingBet + chipValue > state.me.balance) return toast('err_insufficient_balance');
    pendingBet += chipValue;
    sfx.chip();
    renderPlayerBet();
  }
  function renderPlayerBet() {
    renderChipStack(playerSeat.dom.stack, pendingBet);
    playerSeat.dom.betAmount.textContent = pendingBet > 0 ? fmt(pendingBet) : '';
    $('total-bet').textContent = fmt(pendingBet);
  }

  async function bettingPhase() {
    phase = 'betting';
    canBet = true;
    pendingBet = 0;
    renderPlayerBet();
    playerSeat.dom.nameEl.textContent = t('bj_you');
    playerSeat.dom.root.classList.toggle('can-bet', canJoin);
    setStatus('bj_place_bets', BET_SECONDS);

    // bots place cosmetic bets at staggered moments within the window
    for (const seat of seats) {
      if (seat.kind !== 'bot') continue;
      const when = randInt(BET_SECONDS - 2) * 1000;
      setTimeout(() => {
        if (phase !== 'betting' || seat.kind !== 'bot') return;
        seat.bet = pick(CHIP_BASE.filter((v) => v <= maxBet)) || minBet;
        renderChipStack(seat.dom.stack, seat.bet);
        seat.dom.betAmount.textContent = fmt(seat.bet);
        sfx.chip();
      }, when);
    }

    for (let s = BET_SECONDS; s > 0; s--) {
      setStatus('bj_place_bets', s);
      await delay(1000);
    }
    canBet = false;
    playerSeat.dom.root.classList.remove('can-bet');

    if (pendingBet > 0 && pendingBet < minBet) {
      toast('err_bet_too_small');
      pendingBet = 0;
      renderPlayerBet();
    }
    return pendingBet > 0;
  }

  // ── dealing ─────────────────────────────────────────────────────
  function appendCard(seat, card, opts) {
    const node = cardEl(card, opts);
    seat.dom.hand.append(node);
    sfx.deal();
    return node;
  }
  function refreshSeatTotal(seat) {
    // base the shown total on how many cards are actually rendered, so
    // the number never runs ahead of the deal animation
    const shown = seat.dom.hand.children.length;
    seat.dom.totalEl.textContent = shown ? String(handTotal(seat.hand.slice(0, shown)).total) : '';
  }

  async function dealPhase(joined, resume) {
    phase = 'dealing';
    setStatus('bj_dealing');
    const round = { joined, resolved: false, playerRound: null, realState: null, dealerUp: null, dealerHole: null, dealerFull: null };

    if (joined) {
      let res;
      if (resume) {
        res = { state: resume };
      } else {
        res = await api('/api/game/blackjack/deal', { method: 'POST', body: { bet: pendingBet } });
      }
      if (res.balance !== undefined) updateBalance(res.balance);
      if (res.round) {
        round.resolved = true;
        round.playerRound = res.round;
        round.dealerFull = res.round.outcome.dealer;
        round.dealerUp = res.round.outcome.dealer[0];
        playerSeat.hand = res.round.outcome.player.slice();
      } else {
        round.realState = res.state;
        round.dealerUp = res.state.dealer_up;
        playerSeat.hand = res.state.player.slice();
      }
      playerSeat.bet = round.playerRound ? round.playerRound.bet : res.state.bet;
      renderChipStack(playerSeat.dom.stack, playerSeat.bet);
      playerSeat.dom.betAmount.textContent = fmt(playerSeat.bet);
    } else {
      round.dealerUp = drawCosmetic();
      round.dealerHole = drawCosmetic();
    }

    const active = seats.filter((s) => s.kind === 'bot' || (s.mine && joined));
    // two passes, dealing left to right, dealer last each pass
    for (let pass = 0; pass < 2; pass++) {
      for (const seat of active) {
        if (seat.mine) {
          appendCard(seat, playerSeat.hand[pass]);
        } else {
          const card = drawCosmetic();
          seat.hand.push(card);
          appendCard(seat, card);
        }
        refreshSeatTotal(seat);
        await delay(140);
      }
      if (pass === 0) {
        dealerHandEl.append(cardEl(round.dealerUp));
        setDealerTotal([round.dealerUp]);
        sfx.deal();
      } else {
        // the hidden value only matters when the dealer is cosmetic
        // (spectating): revealCard reads it. When the player joined,
        // the real hole is unknown until the server reveals it and we
        // replace this element by hand.
        const hidden = joined ? round.dealerUp : round.dealerHole;
        dealerHoleEl = cardEl(hidden, { faceDown: true });
        dealerHandEl.append(dealerHoleEl);
        sfx.deal();
      }
      await delay(160);
    }

    // resuming a hand that already had extra cards: render the rest
    if (joined) {
      for (let i = playerSeat.dom.hand.children.length; i < playerSeat.hand.length; i++) {
        appendCard(playerSeat, playerSeat.hand[i]);
      }
      refreshSeatTotal(playerSeat);
    }
    return round;
  }

  // ── play phase ──────────────────────────────────────────────────
  // Bots pause for a random "thinking" beat before each decision, so
  // the table never feels mechanical — different every hand.
  const think = () => delay(500 + randInt(1400));

  async function playBot(seat, dealerUp) {
    seat.dom.root.classList.add('active');
    await think();
    while (true) {
      const total = handTotal(seat.hand).total;
      if (total >= 21) break;
      const action = botAction(seat.hand, dealerUp);
      if (action === 'stand') break;
      const card = drawCosmetic();
      seat.hand.push(card);
      appendCard(seat, card);
      refreshSeatTotal(seat);
      if (action === 'double') break;
      await think();
    }
    await delay(200 + randInt(350));
    seat.dom.root.classList.remove('active');
  }

  function showActions(canDouble) {
    $('actions').hidden = false;
    $('hit-btn').disabled = false;
    $('stand-btn').disabled = false;
    $('double-btn').disabled = !canDouble;
  }
  function hideActions() {
    $('actions').hidden = true;
  }
  function waitPlayerChoice() {
    return new Promise((resolve) => {
      playerChoiceResolver = resolve;
      turnTimer = setTimeout(() => resolvePlayer('stand'), TURN_SECONDS * 1000);
    });
  }
  function resolvePlayer(choice) {
    if (!playerChoiceResolver) return;
    clearTimeout(turnTimer);
    const r = playerChoiceResolver;
    playerChoiceResolver = null;
    r(choice);
  }
  $('hit-btn').addEventListener('click', () => { sfx.button(); resolvePlayer('hit'); });
  $('stand-btn').addEventListener('click', () => { sfx.button(); resolvePlayer('stand'); });
  $('double-btn').addEventListener('click', () => { sfx.button(); resolvePlayer('double'); });

  function renderPlayerHandFrom(cards) {
    // append only newly dealt cards
    for (let i = playerSeat.hand.length; i < cards.length; i++) {
      appendCard(playerSeat, cards[i]);
    }
    playerSeat.hand = cards.slice();
    refreshSeatTotal(playerSeat);
  }

  async function playerTurn(round) {
    playerSeat.dom.root.classList.add('active');
    setStatus('bj_your_turn');
    let canDouble = round.realState.can_double;
    showActions(canDouble);
    let acting = true;
    while (acting) {
      const choice = await waitPlayerChoice();
      $('hit-btn').disabled = true;
      $('stand-btn').disabled = true;
      $('double-btn').disabled = true;
      try {
        let res;
        if (choice === 'hit') res = await api('/api/game/blackjack/hit', { method: 'POST' });
        else if (choice === 'double') res = await api('/api/game/blackjack/double', { method: 'POST' });
        else res = await api('/api/game/blackjack/stand', { method: 'POST' });
        if (res.balance !== undefined) updateBalance(res.balance);
        if (res.round) {
          renderPlayerHandFrom(res.round.outcome.player);
          round.resolved = true;
          round.playerRound = res.round;
          round.dealerFull = res.round.outcome.dealer;
          acting = false;
        } else {
          renderPlayerHandFrom(res.state.player);
          canDouble = false;
          showActions(false);
        }
      } catch (err) {
        toastError(err);
        showActions(canDouble);
      }
    }
    hideActions();
    playerSeat.dom.root.classList.remove('active');
  }

  async function playPhase(joined, round) {
    phase = 'playing';
    for (const seat of seats) {
      if (seat.mine) {
        if (joined && !round.resolved) await playerTurn(round);
      } else if (seat.kind === 'bot') {
        setStatus();
        await playBot(seat, round.dealerUp);
      }
    }
  }

  // ── dealer phase ────────────────────────────────────────────────
  async function dealerPhase(joined, round) {
    phase = 'dealer';
    setStatus('bj_dealer_turn');
    await delay(400);

    let dealer;
    if (joined) {
      dealer = round.dealerFull.slice();
      // flip the hole to its real value, then draw the rest
      if (dealerHoleEl) {
        const faceEl = cardEl(dealer[1]);
        faceEl.classList.add('flip-in');
        dealerHoleEl.replaceWith(faceEl);
        dealerHoleEl = null;
        sfx.flip();
      }
      setDealerTotal(dealer.slice(0, 2));
      await delay(450);
      for (let i = 2; i < dealer.length; i++) {
        dealerHandEl.append(cardEl(dealer[i]));
        sfx.deal();
        setDealerTotal(dealer.slice(0, i + 1));
        await delay(500);
      }
    } else {
      if (dealerHoleEl) {
        revealCard(dealerHoleEl);
        dealerHoleEl = null;
        sfx.flip();
      }
      dealer = [round.dealerUp, round.dealerHole];
      setDealerTotal(dealer);
      await delay(450);
      dealerDraw(dealer, () => {
        const c = drawCosmetic();
        dealerHandEl.append(cardEl(c));
        sfx.deal();
        return c;
      });
      setDealerTotal(dealer);
      await delay(300);
    }
    round.dealerTotal = handTotal(dealer).total;
    round.dealerCards = dealer;
    return dealer;
  }

  // ── payouts ─────────────────────────────────────────────────────
  const RESULT_KEY = { blackjack: 'bj_blackjack', win: 'bj_win', lose: 'bj_lose', push: 'bj_push' };
  const RESULT_CLASS = { blackjack: 'bj', win: 'win', lose: 'lose', push: 'push' };

  function botResult(seat, dealer, dealerTotal) {
    const p = handTotal(seat.hand).total;
    if (isBlackjack(seat.hand) && !isBlackjack(dealer)) return 'blackjack';
    if (p > 21) return 'lose';
    if (isBlackjack(dealer) && !isBlackjack(seat.hand)) return 'lose';
    if (dealerTotal > 21) return 'win';
    if (p > dealerTotal) return 'win';
    if (p < dealerTotal) return 'lose';
    return 'push';
  }

  function showBadge(seat, result) {
    seat.dom.badge.className = `bj-seat-badge ${RESULT_CLASS[result]}`;
    seat.dom.badge.textContent = t(RESULT_KEY[result]);
  }

  async function payoutPhase(joined, round) {
    phase = 'payout';
    setStatus();
    const dealer = round.dealerCards;
    const dealerTotal = round.dealerTotal;
    for (const seat of seats) {
      if (seat.mine) {
        if (joined && round.playerRound) {
          const r = round.playerRound.outcome.result;
          showBadge(seat, r);
          if (r === 'blackjack') sfx.big();
          else if (r === 'win') sfx.win();
          else if (r === 'lose') sfx.lose();
          else sfx.push();
        }
      } else if (seat.kind === 'bot' && seat.hand.length) {
        showBadge(seat, botResult(seat, dealer, dealerTotal));
      }
    }
    await delay(3200);
  }

  // ── round lifecycle ─────────────────────────────────────────────
  function resetRound() {
    dealerHandEl.textContent = '';
    dealerHoleEl = null;
    setDealerTotal([]);
    for (const seat of seats) clearSeatVisual(seat);
    pendingBet = 0;
  }

  // ── controls ────────────────────────────────────────────────────
  function buildRack() {
    const rack = $('rack');
    const usable = CHIP_BASE.filter((v) => v <= maxBet);
    const values = usable.length ? usable : [minBet];
    for (const v of values) {
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
    if (!values.includes(chipValue)) chipValue = values[0];
  }
  buildRack();
  $('limits').textContent = `${t('bj_min')}: ${fmt(minBet)}  ·  ${t('bj_max')}: ${fmt(maxBet)}`;
  $('clear-btn').addEventListener('click', () => {
    if (phase === 'betting') {
      pendingBet = 0;
      renderPlayerBet();
    }
  });

  if (!canJoin) {
    playerSeat.dom.root.classList.remove('can-bet');
    toast('err_game_disabled');
  }

  // ── main loop ───────────────────────────────────────────────────
  // Resume an open server round (player reloaded mid-hand) before the
  // normal betting loop takes over.
  let resumeState = null;
  try {
    const existing = await api('/api/game/blackjack/state');
    if (existing.state) resumeState = existing.state;
  } catch {
    /* not fatal */
  }

  async function loop() {
    for (;;) {
      await ensureShoe();
      let joined;
      if (resumeState) {
        joined = true;
        assignBots();
      } else {
        assignBots();
        joined = await bettingPhase();
      }
      const round = await dealPhase(joined, resumeState);
      resumeState = null;
      await playPhase(joined, round);
      await dealerPhase(joined, round);
      await payoutPhase(joined, round);
      resetRound();
    }
  }

  loop().catch((err) => {
    console.error(err);
    toast('err_generic');
  });
}
