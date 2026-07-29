import { initShell, state, el, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { fmt, getLocale } from '../i18n.js';
import { createBetControl } from '../bet.js';

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let direction = 'under';
  let busy = false;

  const bet = createBetControl({
    container: $('bet-control'),
    min: state.pub.min_bet,
    max: state.pub.max_bet,
    getBalance: () => (state.me ? state.me.balance : 0),
  });

  // Mirrors the server's exact rational probabilities.
  const chance = (target, dir) =>
    dir === 'under' ? (target * 100) / 10000 : (9999 - target * 100) / 10000;

  function refreshStats() {
    const target = Number($('target').value);
    $('target-value').textContent = String(target);
    const p = chance(target, direction);
    const mult = state.pub.rtp / p;
    $('chance').textContent = new Intl.NumberFormat(getLocale() === 'ka' ? 'ka-GE' : 'en-US', {
      style: 'percent',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(p);
    $('mult').textContent = `${mult.toFixed(3)}×`;
    const winEl = $('bar-win');
    winEl.style.width = `${p * 100}%`;
    winEl.style.left = direction === 'under' ? '0' : `${100 - p * 100}%`;
  }

  $('target').addEventListener('input', refreshStats);
  $('dir-under').addEventListener('click', () => setDirection('under'));
  $('dir-over').addEventListener('click', () => setDirection('over'));
  function setDirection(dir) {
    direction = dir;
    $('dir-under').classList.toggle('active', dir === 'under');
    $('dir-over').classList.toggle('active', dir === 'over');
    refreshStats();
  }
  refreshStats();

  const results = [];
  function renderStrip() {
    const strip = $('strip');
    strip.textContent = '';
    for (const r of results) {
      strip.append(
        el('span', { cls: `cell ${r.win ? 'win' : 'lose'}`, text: r.roll.toFixed(2) }),
      );
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  $('roll-btn').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    $('roll-btn').disabled = true;
    bet.setDisabled(true);
    $('result').textContent = '';
    $('bar-marker').hidden = true;
    const stake = bet.value;
    const target = Number($('target').value);

    // Cosmetic number cycle while the request is in flight.
    let step = 0;
    const display = $('roll-display');
    const timer = setInterval(() => {
      step = (step * 7 + 13) % 10000;
      display.textContent = (step / 100).toFixed(2);
    }, 50);

    try {
      const res = await api('/api/game/dice/roll', {
        method: 'POST',
        body: { bet: stake, target, direction },
      });
      await sleep(600);
      clearInterval(timer);
      const out = res.round.outcome;
      display.textContent = out.roll.toFixed(2);
      display.className = `dice-roll num ${out.win ? 'win-text' : 'lose-text'}`;
      const marker = $('bar-marker');
      marker.hidden = false;
      marker.style.left = `${out.roll}%`;
      const line = $('result');
      if (out.win) {
        line.textContent = `+${fmt(res.round.payout)}`;
        line.className = 'result-line win-text';
      } else {
        line.textContent = `−${fmt(stake)}`;
        line.className = 'result-line lose-text';
      }
      results.unshift({ roll: out.roll, win: out.win });
      if (results.length > 12) results.pop();
      renderStrip();
      updateBalance(res.balance);
    } catch (err) {
      clearInterval(timer);
      display.textContent = '··.··';
      display.className = 'dice-roll num';
      toastError(err);
    } finally {
      busy = false;
      $('roll-btn').disabled = false;
      bet.setDisabled(false);
    }
  });
}
