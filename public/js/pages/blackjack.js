import { initShell, state, el, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { createBetControl } from '../bet.js';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const RESULT_KEYS = {
  blackjack: 'bj_blackjack',
  win: 'bj_win',
  lose: 'bj_lose',
  push: 'bj_push',
};

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let busy = false;
  let stake = 0;

  const bet = createBetControl({
    container: $('bet-control'),
    min: state.pub.min_bet,
    max: state.pub.max_bet,
    getBalance: () => (state.me ? state.me.balance : 0),
  });

  function handTotal(cards) {
    let total = 0;
    let aces = 0;
    for (const card of cards) {
      const r = card % 13;
      total += r === 0 ? 11 : r >= 9 ? 10 : r + 1;
      if (r === 0) aces++;
    }
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }
    return total;
  }

  function cardEl(card) {
    const rank = card % 13;
    const suit = Math.floor(card / 13);
    return el('div', { cls: `card${suit === 1 || suit === 2 ? ' red' : ''}` }, [
      el('span', { cls: 'rank', text: RANKS[rank] }),
      el('span', { cls: 'suit', text: SUITS[suit] }),
    ]);
  }
  const backEl = () => el('div', { cls: 'card back', text: '◆' });

  function renderHands({ player, dealerUp, dealerFull }) {
    const dealerHand = $('dealer-hand');
    const playerHand = $('player-hand');
    dealerHand.textContent = '';
    playerHand.textContent = '';
    if (dealerFull) {
      for (const card of dealerFull) dealerHand.append(cardEl(card));
      $('dealer-total').textContent = String(handTotal(dealerFull));
    } else if (dealerUp !== undefined) {
      dealerHand.append(cardEl(dealerUp), backEl());
      $('dealer-total').textContent = '?';
    } else {
      $('dealer-total').textContent = '';
    }
    for (const card of player || []) playerHand.append(cardEl(card));
    $('player-total').textContent = player ? String(handTotal(player)) : '';
  }

  function setPhase(phase, canDouble = false) {
    const playing = phase === 'playing';
    $('actions').hidden = !playing;
    $('deal-btn').disabled = playing || busy;
    bet.setDisabled(playing || busy);
    $('double-btn').hidden = !canDouble;
    $('hit-btn').disabled = busy;
    $('stand-btn').disabled = busy;
    $('double-btn').disabled = busy || state.me.balance < stake;
  }

  const results = [];
  function renderStrip() {
    const strip = $('strip');
    strip.textContent = '';
    for (const r of results) {
      const cls = r.net > 0 ? 'win' : r.net < 0 ? 'lose' : '';
      const text = r.net > 0 ? `+${r.net}` : String(r.net);
      strip.append(el('span', { cls: `cell ${cls}`, text }));
    }
  }

  function showState(st) {
    stake = st.bet;
    renderHands({ player: st.player, dealerUp: st.dealer_up });
    $('result').textContent = '';
    setPhase('playing', st.can_double);
  }

  function showResolved(res) {
    const { round } = res;
    renderHands({ player: round.outcome.player, dealerFull: round.outcome.dealer });
    const line = $('result');
    const label = t(RESULT_KEYS[round.outcome.result] || 'bj_push');
    if (round.net > 0) {
      line.textContent = `${label} · +${fmt(round.net)}`;
      line.className = 'result-line win-text';
    } else if (round.net < 0) {
      line.textContent = `${label} · −${fmt(-round.net)}`;
      line.className = 'result-line lose-text';
    } else {
      line.textContent = `${label} · 0`;
      line.className = 'result-line muted';
    }
    results.unshift({ net: round.net });
    if (results.length > 12) results.pop();
    renderStrip();
    if (res.balance !== undefined) updateBalance(res.balance);
    setPhase('idle');
  }

  async function act(url, body) {
    if (busy) return;
    busy = true;
    setPhase($('actions').hidden ? 'idle' : 'playing', !$('double-btn').hidden);
    try {
      const res = await api(url, { method: 'POST', body });
      if (res.round) {
        showResolved(res);
      } else if (res.state) {
        if (res.balance !== undefined) updateBalance(res.balance);
        showState(res.state);
      }
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
      const playing = !$('actions').hidden;
      setPhase(playing ? 'playing' : 'idle', playing && !$('double-btn').hidden);
    }
  }

  $('deal-btn').addEventListener('click', () => act('/api/game/blackjack/deal', { bet: bet.value }));
  $('hit-btn').addEventListener('click', () => act('/api/game/blackjack/hit'));
  $('stand-btn').addEventListener('click', () => act('/api/game/blackjack/stand'));
  $('double-btn').addEventListener('click', () => act('/api/game/blackjack/double'));

  // Resume an open round after a reload — the bet is already staked.
  const existing = await api('/api/game/blackjack/state');
  if (existing.state) showState(existing.state);
  else setPhase('idle');
}
