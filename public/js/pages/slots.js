import { initShell, state, el, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { fmt } from '../i18n.js';
import { createBetControl } from '../bet.js';

// Client-side display mapping only. Symbol indexes come from the
// server; the paytable mirrors the fixed multiplier ladder.
const SYMBOLS = ['🍋', '🍒', '🍇', '🔔', '⭐', '💎', '7️⃣', '👑', '🎰'];
const MULT = [0.5, 1, 2, 5, 10, 25, 100, 500, 2000];

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  const reels = [$('reel-0'), $('reel-1'), $('reel-2')];
  const result = $('result');
  const strip = $('strip');
  const spinBtn = $('spin-btn');

  const bet = createBetControl({
    container: $('bet-control'),
    min: state.pub.min_bet,
    max: state.pub.max_bet,
    getBalance: () => (state.me ? state.me.balance : 0),
  });

  // Paytable: three of a kind → multiplier.
  const payBody = $('paytable-body');
  for (let i = MULT.length - 1; i >= 0; i--) {
    payBody.append(
      el('tr', {}, [
        el('td', { text: `${SYMBOLS[i]} ${SYMBOLS[i]} ${SYMBOLS[i]}` }),
        el('td', { cls: 'num', text: `${MULT[i]}×` }),
      ]),
    );
  }

  const results = [];
  function renderStrip() {
    strip.textContent = '';
    for (const r of results) {
      strip.append(
        el('span', {
          cls: `cell ${r.mult > 0 ? 'win' : 'lose'}`,
          text: `${r.mult}×`,
        }),
      );
    }
  }

  // Cosmetic-only reel shuffle while waiting for the server; the
  // outcome is fully decided server-side and animation never uses it.
  let shuffleTimer = null;
  let shuffleStep = 0;
  function startShuffle() {
    for (const reel of reels) {
      reel.classList.add('spinning');
      reel.classList.remove('hit');
    }
    shuffleTimer = setInterval(() => {
      shuffleStep++;
      reels.forEach((reel, i) => {
        reel.textContent = SYMBOLS[(shuffleStep + i * 3) % SYMBOLS.length];
      });
    }, 70);
  }
  function stopShuffle() {
    clearInterval(shuffleTimer);
    shuffleTimer = null;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let busy = false;
  spinBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    spinBtn.disabled = true;
    bet.setDisabled(true);
    result.textContent = '';
    const stake = bet.value;
    startShuffle();
    const started = Date.now();
    try {
      const res = await api('/api/game/slots/spin', { method: 'POST', body: { bet: stake } });
      // Let the reels turn for at least ~700ms, then settle one by one.
      await sleep(Math.max(0, 700 - (Date.now() - started)));
      stopShuffle();
      const shown = res.round.outcome.reels;
      for (let i = 0; i < reels.length; i++) {
        reels[i].classList.remove('spinning');
        reels[i].textContent = SYMBOLS[shown[i]];
        await sleep(140);
      }
      const { mult } = res.round.outcome;
      if (mult > 0) {
        for (const reel of reels) reel.classList.add('hit');
        result.textContent = `${mult}× · +${fmt(res.round.payout)}`;
        result.className = 'result-line win-text';
      } else {
        result.textContent = `−${fmt(stake)}`;
        result.className = 'result-line lose-text';
      }
      results.unshift({ mult });
      if (results.length > 12) results.pop();
      renderStrip();
      updateBalance(res.balance);
    } catch (err) {
      stopShuffle();
      for (const reel of reels) {
        reel.classList.remove('spinning');
      }
      toastError(err);
    } finally {
      busy = false;
      spinBtn.disabled = false;
      bet.setDisabled(false);
    }
  });
}
