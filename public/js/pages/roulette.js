import { initShell, state, el, toast, toastError, updateBalance } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { sfx } from '../sound.js';

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const CHIP_VALUES = [1, 5, 10, 25, 100];

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let chip = 5;
  let bets = [];
  let splitFirst = null;
  let busy = false;
  const numberCells = new Map(); // n -> cell
  const outsideCells = new Map(); // key -> cell

  const betKey = (bet) => `${bet.type}:${JSON.stringify(bet.selection ?? null)}`;
  const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');

  // ── board ───────────────────────────────────────────────────────
  function numberCell(n) {
    const cell = el('button', {
      cls: `rcell ${colorOf(n)}`,
      text: String(n),
      attrs: { type: 'button' },
      on: { click: () => onNumberClick(n) },
    });
    numberCells.set(n, cell);
    return cell;
  }

  const board = $('board');
  const zero = numberCell(0);
  zero.style.gridColumn = '1';
  zero.style.gridRow = '1 / span 3';
  board.append(zero);
  for (let col = 1; col <= 12; col++) {
    for (let row = 0; row < 3; row++) {
      const n = col * 3 - row; // top row shows 3,6,…36
      const cell = numberCell(n);
      cell.style.gridColumn = String(col + 1);
      cell.style.gridRow = String(row + 1);
      board.append(cell);
    }
  }
  for (let colBet = 0; colBet < 3; colBet++) {
    const selection = 2 - colBet; // top visual row is column 3 (3,6,…)
    const cell = el('button', {
      cls: 'rcell outside',
      text: '2:1',
      attrs: { type: 'button' },
      on: { click: () => addBet({ type: 'column', selection }) },
    });
    cell.style.gridColumn = '14';
    cell.style.gridRow = String(colBet + 1);
    outsideCells.set(`column:${selection}`, cell);
    board.append(cell);
  }

  const outside = $('outside');
  const outsideDefs = [
    ['dozen', 0, 'roulette_d1'], ['dozen', 1, 'roulette_d2'], ['dozen', 2, 'roulette_d3'],
    ['odd', null, 'roulette_odd'], ['red', null, 'roulette_red'],
    ['black', null, 'roulette_black'], ['even', null, 'roulette_even'],
  ];
  for (const [type, selection, key] of outsideDefs) {
    const cell = el('button', {
      cls: `rcell outside wide ${type === 'red' ? 'red' : ''} ${type === 'black' ? 'black' : ''}`,
      dataT: key,
      attrs: { type: 'button' },
      on: { click: () => addBet(selection === null ? { type } : { type, selection }) },
    });
    outsideCells.set(`${type}:${JSON.stringify(selection)}`, cell);
    outside.append(cell);
  }

  // ── chips ───────────────────────────────────────────────────────
  const chipRow = $('chips');
  for (const value of CHIP_VALUES) {
    const button = el('button', {
      cls: `chip${value === chip ? ' selected' : ''}`,
      text: String(value),
      attrs: { type: 'button' },
      on: {
        click: () => {
          chip = value;
          for (const c of chipRow.children) c.classList.toggle('selected', Number(c.textContent) === chip);
        },
      },
    });
    chipRow.append(button);
  }

  // ── bet placement ───────────────────────────────────────────────
  function validSplit(a, b) {
    if (a > b) [a, b] = [b, a];
    if (a === 0) return b >= 1 && b <= 3;
    if (a < 1 || b > 36) return false;
    if (b - a === 3) return true;
    if (b - a === 1) return a % 3 !== 0;
    return false;
  }

  function onNumberClick(n) {
    if (!$('split-mode').checked) {
      addBet({ type: 'straight', selection: n });
      return;
    }
    if (splitFirst === null) {
      splitFirst = n;
      numberCells.get(n).classList.add('split-first');
      $('split-hint').hidden = false;
      return;
    }
    const [a, b] = splitFirst <= n ? [splitFirst, n] : [n, splitFirst];
    numberCells.get(splitFirst).classList.remove('split-first');
    $('split-hint').hidden = true;
    const first = splitFirst;
    splitFirst = null;
    if (first === n || !validSplit(a, b)) {
      toast('err_invalid_bet');
      return;
    }
    addBet({ type: 'split', selection: [a, b] });
  }

  function addBet(partial) {
    if (busy) return;
    const key = betKey(partial);
    const existing = bets.find((b) => betKey(b) === key);
    if (existing) existing.amount += chip;
    else bets.push({ ...partial, amount: chip });
    sfx.chip();
    renderBets();
  }

  function betLabel(bet) {
    switch (bet.type) {
      case 'straight': return `${t('bt_straight')} ${bet.selection}`;
      case 'split': return `${t('bt_split')} ${bet.selection[0]}·${bet.selection[1]}`;
      case 'dozen': return t(`roulette_d${bet.selection + 1}`);
      case 'column': return `${t('roulette_col_name')} ${bet.selection + 1}`;
      default: return t(`roulette_${bet.type}`);
    }
  }

  function renderBets(winners = null) {
    const list = $('bets-list');
    list.textContent = '';
    let total = 0;
    for (const bet of bets) {
      total += bet.amount;
      const row = el('div', { cls: 'bet-row' }, [
        el('span', { text: betLabel(bet) }),
        el('strong', { cls: 'num', text: fmt(bet.amount) }),
        el('button', {
          cls: 'bet-remove', text: '✕', attrs: { type: 'button' },
          on: { click: () => { bets = bets.filter((b) => b !== bet); renderBets(); } },
        }),
      ]);
      if (winners && winners.has(betKey(bet))) row.classList.add('won');
      list.append(row);
    }
    $('total').textContent = fmt(total);
    $('spin-btn').disabled = busy || total === 0;

    for (const [n, cell] of numberCells) {
      const marked = bets.some(
        (b) =>
          (b.type === 'straight' && b.selection === n) ||
          (b.type === 'split' && b.selection.includes(n)),
      );
      cell.classList.toggle('has-bet', marked);
    }
    for (const [key, cell] of outsideCells) {
      cell.classList.toggle('has-bet', bets.some((b) => betKey(b) === key));
    }
  }
  renderBets();

  $('clear-btn').addEventListener('click', () => {
    bets = [];
    renderBets();
  });

  // ── spin ────────────────────────────────────────────────────────
  const results = [];
  function renderStrip() {
    const strip = $('strip');
    strip.textContent = '';
    for (const n of results) {
      strip.append(el('span', { cls: `cell pocket-${colorOf(n)}`, text: String(n) }));
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pocket = $('pocket');

  $('spin-btn').addEventListener('click', async () => {
    if (busy || bets.length === 0) return;
    busy = true;
    $('spin-btn').disabled = true;
    $('result').textContent = '';
    const payloadBets = bets.map(({ type, selection, amount }) =>
      selection === undefined ? { type, amount } : { type, selection, amount },
    );
    const total = bets.reduce((sum, b) => sum + b.amount, 0);

    // Cosmetic pocket cycle while the request resolves (deterministic
    // sequence — the outcome is decided server-side).
    let step = 0;
    pocket.className = 'pocket spin';
    sfx.spin();
    const timer = setInterval(() => {
      step = (step + 7) % 37;
      pocket.textContent = String(step);
    }, 60);

    try {
      const res = await api('/api/game/roulette/spin', {
        method: 'POST',
        body: { bets: payloadBets },
      });
      await sleep(900);
      clearInterval(timer);
      const { number } = res.round.outcome;
      pocket.className = `pocket ${colorOf(number)}`;
      pocket.textContent = String(number);

      const payout = res.round.payout;
      const line = $('result');
      if (payout > 0) {
        line.textContent = `+${fmt(payout)}`;
        line.className = 'result-line win-text';
        if (payout >= total * 5) sfx.big();
        else sfx.win();
      } else {
        line.textContent = `−${fmt(total)}`;
        line.className = 'result-line lose-text';
        sfx.lose();
      }
      const winners = new Set(
        res.round.outcome.bets.filter((b) => b.win).map((b) => betKey(b)),
      );
      renderBets(winners);
      results.unshift(number);
      if (results.length > 12) results.pop();
      renderStrip();
      updateBalance(res.balance);
    } catch (err) {
      clearInterval(timer);
      pocket.className = 'pocket';
      toastError(err);
    } finally {
      busy = false;
      renderBets();
    }
  });
}
