import { initShell, state, el, toastError, updateBalance, onLocaleChange } from '../shell.js';
import { api } from '../api.js';
import { fmt, t, applyI18n } from '../i18n.js';
import { createBetControl } from '../bet.js';
import { sfx, slotKit } from '../sound.js';
import { theme } from '../slot-themes.js';
import { lineArt, artFor } from '../slot-line-art.js';
import { lineMachine, lineGrid, lineEvaluate, linePayScale } from '../verify-core.js';

// The slots floor. Machines, their paytables and their odds all come
// from the server registry — this page never keeps a second copy of the
// numbers, so what a player reads in the paytable is what the spin was
// resolved against. Symbols, colours, timings and sound are the only
// things chosen here, and none of them can see an outcome before the
// server has already fixed it.
//
// Two kinds of cabinet share the page. A ladder machine draws one row of
// symbols against a multiplier table; a payline machine draws a grid and
// pays every line that opens on the leftmost reel. `kind` on the server
// view decides which path runs — nothing else here guesses.
//
// A payline round records only its reel stops, because the grid and
// every win follow from them. This page rebuilds both with the same
// module the fairness verifier uses, so the screen is showing what the
// committed stops actually mean rather than a second telling of it.

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let config = null;
  try {
    config = await api('/api/game/slots/machines');
  } catch (err) {
    toastError(err);
  }

  if (config) {
    const byId = new Map(config.machines.map((m) => [m.id, m]));

    const pct = (v) => `${(v * 100).toFixed(1)}%`;
    const volKey = (m) => `vol_${m.volatility}`;
    const nameOf = (m) => t(`slot_name_${m.id}`);
    const isLines = (m) => m.kind === 'lines';
    // Timings, landing animation and sound: the two registries answer
    // the same four fields, so everything downstream is shape-blind.
    const look = (m) => (isLines(m) ? lineArt(m.id) : theme(m.id));
    // A scaled pay value is rarely a round number. Two decimals is
    // enough to be exact at every RTP the admin can set.
    const px = (v) => fmt(Math.round(v * 100) / 100);

    // One sound kit per machine, built the first time a cabinet opens.
    const kits = new Map();
    const kitFor = (m) => {
      if (!kits.has(m.id)) kits.set(m.id, slotKit(look(m).sound));
      return kits.get(m.id);
    };

    // A ladder cabinet is fronted by an emoji, a payline cabinet by the
    // sprite of a symbol that really is on its reels.
    function paintArt(node, m) {
      node.textContent = '';
      if (isLines(m)) {
        node.append(el('img', {
          cls: 'art-img',
          attrs: { src: artFor(lineArt(m.id).lead), alt: '', draggable: 'false' },
        }));
      } else {
        node.textContent = theme(m.id).art;
      }
    }

    function artNode(m) {
      const node = el('span', { cls: 'card-art' });
      paintArt(node, m);
      return node;
    }

    // ── the floor ──────────────────────────────────────────────────
    function statsOf(m) {
      return isLines(m)
        ? [
            [`${m.cols}×${m.rows}`, 'slot_fact_grid'],
            [String(m.lines.length), 'slot_fact_lines'],
            [pct(m.hit_rate), 'slot_fact_hit'],
            [`${px(m.top)}×`, 'slot_fact_topline'],
          ]
        : [
            [String(m.reels), 'slot_fact_reels'],
            [pct(m.hit_rate), 'slot_fact_hit'],
            [`${fmt(m.top)}×`, 'slot_fact_top'],
          ];
    }

    function renderFloor() {
      const grid = $('slot-grid');
      grid.textContent = '';
      for (const m of config.machines) {
        grid.append(
          el('button', {
            cls: `slot-card${isLines(m) ? ' lines' : ''}`,
            attrs: { type: 'button', 'data-machine': m.id },
            on: {
              click: () => {
                sfx.button();
                location.hash = m.id;
              },
            },
          }, [
            artNode(m),
            el('span', { cls: 'card-name', text: nameOf(m) }),
            el('span', { cls: 'card-tag', dataT: `slot_tag_${m.id}` }),
            el('span', { cls: 'card-stats' }, statsOf(m).map(([value, key]) =>
              el('span', { cls: 'stat' }, [
                el('em', { text: value }),
                el('i', { dataT: key }),
              ]))),
            el('span', { cls: `vol-badge vol-${m.volatility}`, dataT: volKey(m) }),
            el('span', { cls: 'card-glow' }),
          ]),
        );
      }
    }

    // ── the cabinet ────────────────────────────────────────────────
    let machine = null; // the open machine's server view
    let spec = null;    // for a payline machine: the browser's own copy
    let kit = null;
    let cells = [];     // ladder: one cell per reel
    let gcells = [];    // payline: [col][row] → { face, img }
    let busy = false;
    const results = [];

    const bet = createBetControl({
      container: $('bet-control'),
      min: state.pub.min_bet,
      max: state.pub.max_bet,
      getBalance: () => (state.me ? state.me.balance : 0),
    });

    function paintFacts() {
      if (!machine) return;
      const rows = isLines(machine)
        ? [
            ['slot_fact_grid', `${machine.cols}×${machine.rows}`],
            ['slot_fact_lines', String(machine.lines.length)],
            ['slot_fact_hit', pct(machine.hit_rate)],
            ['slot_fact_topline', `${px(machine.top)}×`],
            ['slot_fact_vol', t(volKey(machine))],
            ['slot_fact_rtp', pct(config.rtp)],
          ]
        : [
            ['slot_fact_reels', String(machine.reels)],
            ['slot_fact_hit', pct(machine.hit_rate)],
            ['slot_fact_top', `${fmt(machine.top)}×`],
            ['slot_fact_vol', t(volKey(machine))],
            ['slot_fact_rtp', pct(config.rtp)],
          ];
      const dl = $('facts');
      dl.textContent = '';
      for (const [key, value] of rows) {
        dl.append(el('dt', { dataT: key }), el('dd', { cls: 'num', text: value }));
      }
    }

    const symbolImg = (index, cls = 'pay-sym') =>
      el('img', {
        cls,
        attrs: { src: artFor(machine.symbols[index]), alt: '', draggable: 'false' },
      });

    // The wild and the scatter carry all-zero pay rows: the wild is
    // never on the first reel so it cannot open a line of its own, and
    // the scatter is paid from its own table. Printing those zeros as
    // prizes would advertise something nobody can win, so both rows say
    // what the symbol actually does instead.
    function paintLinePaytable() {
      const runs = [];
      for (let r = 3; r <= machine.cols; r++) runs.push(r);

      const head = $('paytable-head');
      head.textContent = '';
      head.append(
        el('tr', {}, [
          el('th', { dataT: 'pay_symbol' }),
          ...runs.map((r) => el('th', { cls: 'num', text: `${r}×` })),
        ]),
      );

      const paying = machine.symbols
        .map((_, s) => s)
        .filter((s) => s !== machine.wild && s !== machine.scatter)
        .sort((a, b) => machine.pay[b][runs.length - 1] - machine.pay[a][runs.length - 1]);

      const body = $('paytable-body');
      body.textContent = '';
      for (const s of paying) {
        body.append(
          el('tr', {}, [
            el('td', {}, [symbolImg(s)]),
            ...runs.map((r, i) =>
              el('td', {
                cls: 'num',
                text: machine.pay[s][i] > 0 ? `${px(machine.pay[s][i])}×` : '—',
              })),
          ]),
        );
      }

      body.append(
        el('tr', { cls: 'pay-special' }, [
          el('td', {}, [symbolImg(machine.wild)]),
          el('td', { attrs: { colspan: String(runs.length) } }, [
            el('b', { dataT: 'slot_wild' }),
            el('span', { cls: 'muted', dataT: 'slot_wild_note' }),
          ]),
        ]),
        el('tr', { cls: 'pay-special' }, [
          el('td', {}, [symbolImg(machine.scatter)]),
          el('td', { attrs: { colspan: String(runs.length) } }, [
            el('b', { dataT: 'slot_scatter' }),
            el('span', {
              cls: 'num',
              text: runs.map((r, i) => `${r} → ${px(machine.scatterPay[i])}×`).join('   '),
            }),
            el('span', { cls: 'muted', dataT: 'slot_scatter_note' }),
          ]),
        ]),
      );

      $('pay-note').textContent = t('slot_pay_lines_note');
    }

    function paintLadderPaytable() {
      const syms = theme(machine.id).symbols;
      const head = $('paytable-head');
      head.textContent = '';
      head.append(
        el('tr', {}, [
          el('th', { dataT: 'pay_symbol' }),
          el('th', { cls: 'num', dataT: 'pay_mult' }),
        ]),
      );
      const body = $('paytable-body');
      body.textContent = '';
      for (let i = machine.mult.length - 1; i >= 0; i--) {
        body.append(
          el('tr', {}, [
            el('td', { text: Array.from({ length: machine.reels }, () => syms[i] ?? '?').join(' ') }),
            el('td', { cls: 'num', text: `${fmt(machine.mult[i])}×` }),
          ]),
        );
      }
      $('pay-note').textContent = `${machine.reels} ${t('slot_of_a_kind')}`;
    }

    function paintPaytable() {
      if (!machine) return;
      if (isLines(machine)) paintLinePaytable();
      else paintLadderPaytable();
    }

    function paintTitles() {
      if (!machine) return;
      paintArt($('cab-art'), machine);
      $('cab-name').textContent = nameOf(machine);
      $('cab-sub').textContent = t(`slot_tag_${machine.id}`);
      const vol = $('cab-vol');
      vol.className = `vol-badge vol-${machine.volatility}`;
      vol.textContent = t(volKey(machine));
    }

    // Idle faces are a fixed pattern, not a random draw — nothing on
    // this page is allowed to look like it produced a result.
    function idleSymbol(i) {
      const syms = theme(machine.id).symbols;
      return syms[(i * 3 + 1) % syms.length];
    }

    function buildReels() {
      const row = $('reel-row');
      row.textContent = '';
      cells = [];
      gcells = [];
      row.dataset.count = String(machine.reels);
      for (let i = 0; i < machine.reels; i++) {
        const cell = el('div', { cls: 'reel', text: idleSymbol(i) });
        row.append(cell);
        cells.push(cell);
      }
    }

    // The grid has no gaps: each cell holds an inset face, so the SVG
    // overlay's viewBox of one unit per cell lands a payline exactly on
    // the centres it passes through, at any size and without measuring.
    function buildGrid() {
      const wrap = $('reel-grid');
      const overlay = $('line-overlay');
      wrap.textContent = '';
      wrap.append(overlay);
      wrap.style.setProperty('--cols', String(machine.cols));
      wrap.style.setProperty('--rows', String(machine.rows));
      overlay.setAttribute('viewBox', `0 0 ${machine.cols} ${machine.rows}`);
      cells = [];
      gcells = [];
      for (let c = 0; c < machine.cols; c++) {
        const column = [];
        for (let r = 0; r < machine.rows; r++) {
          const index = (c * 3 + r * 5 + 1) % machine.symbols.length;
          const img = el('img', {
            attrs: { src: artFor(machine.symbols[index]), alt: '', draggable: 'false' },
          });
          const face = el('span', { cls: 'gface' }, [img]);
          const cell = el('div', { cls: 'gcell', attrs: { style: `grid-area:${r + 1}/${c + 1}` } }, [face]);
          wrap.append(cell);
          column.push({ face, img });
        }
        gcells.push(column);
      }
    }

    function renderStrip() {
      const strip = $('strip');
      strip.textContent = '';
      for (const r of results) {
        strip.append(
          el('span', {
            cls: `cell ${r.net > 0 ? 'win' : r.net < 0 ? 'lose' : ''}`.trim(),
            text: `${px(r.mult)}×`,
          }),
        );
      }
    }

    function clearReadout() {
      $('mult-badge').textContent = '';
      $('net-value').textContent = '';
      $('net-value').className = 'net-value num';
      $('win-list').textContent = '';
      for (const cell of cells) cell.classList.remove('matched', 'landed');
      for (const column of gcells) {
        for (const { face } of column) face.classList.remove('won', 'scattered', 'landed');
      }
      const overlay = $('line-overlay');
      if (overlay) overlay.textContent = '';
    }

    function openMachine(id) {
      machine = byId.get(id);
      if (!machine) {
        location.hash = '';
        return;
      }
      spec = isLines(machine) ? lineMachine(machine.id) : null;
      if (kit) kit.stop();
      kit = kitFor(machine);
      results.length = 0;

      const cab = $('cab');
      cab.dataset.machine = machine.id;
      cab.dataset.land = look(machine).land;
      cab.dataset.kind = isLines(machine) ? 'lines' : 'ladder';
      $('reel-row').hidden = isLines(machine);
      $('reel-grid').hidden = !isLines(machine);
      if (isLines(machine)) {
        // Swapping a sprite in mid-tumble must not wait on the network.
        for (const key of machine.symbols) new Image().src = artFor(key);
        buildGrid();
      } else {
        buildReels();
      }
      clearReadout();
      renderStrip();
      paintTitles();
      paintFacts();
      paintPaytable();

      $('floor').hidden = true;
      $('cabinet').hidden = false;
      $('back-btn').hidden = false;
      applyI18n($('cabinet'));
    }

    function showFloor() {
      if (kit) kit.stop();
      machine = null;
      spec = null;
      $('cabinet').hidden = true;
      $('floor').hidden = false;
      $('back-btn').hidden = true;
      renderFloor();
      applyI18n($('floor'));
    }

    // ── spinning ───────────────────────────────────────────────────
    let shuffleTimer = null;
    let shuffleStep = 0;

    // Cosmetic only: the reels tumble through the symbol list on a
    // timer while the request is in flight. The outcome is not known
    // here yet and the animation never consults it.
    function startShuffle() {
      shuffleStep = 0;
      if (isLines(machine)) {
        const keys = machine.symbols;
        for (const column of gcells) for (const { face } of column) {
          face.classList.add('spinning');
          face.classList.remove('won', 'scattered', 'landed');
        }
        shuffleTimer = setInterval(() => {
          shuffleStep++;
          gcells.forEach((column, c) => {
            column.forEach(({ img }, r) => {
              img.src = artFor(keys[(shuffleStep + c * 3 + r) % keys.length]);
            });
          });
        }, 70);
        return;
      }
      const syms = theme(machine.id).symbols;
      for (const cell of cells) {
        cell.classList.add('spinning');
        cell.classList.remove('matched', 'landed');
      }
      shuffleTimer = setInterval(() => {
        shuffleStep++;
        cells.forEach((cell, i) => {
          cell.textContent = syms[(shuffleStep + i * 3) % syms.length];
        });
      }, 65);
    }

    function stopShuffle() {
      clearInterval(shuffleTimer);
      shuffleTimer = null;
    }

    function stopSpinning() {
      for (const cell of cells) cell.classList.remove('spinning');
      for (const column of gcells) for (const { face } of column) face.classList.remove('spinning');
    }

    // One polyline per winning line, over the cells the run actually
    // covers. Colours are a function of the line index so two lines that
    // overlap stay tellable apart, and the stroke is non-scaling so the
    // stretched viewBox cannot make it thicker one way than the other.
    function drawWinLines(wins) {
      const overlay = $('line-overlay');
      overlay.textContent = '';
      wins.forEach((w, order) => {
        const path = spec.lines[w.line]
          .slice(0, w.run)
          .map((row, col) => `${col + 0.5},${row + 0.5}`)
          .join(' ');
        const poly = document.createElementNS(SVG_NS, 'polyline');
        poly.setAttribute('points', path);
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', `hsl(${(w.line * 47) % 360} 92% 64%)`);
        poly.setAttribute('stroke-width', '3');
        poly.setAttribute('stroke-linecap', 'round');
        poly.setAttribute('stroke-linejoin', 'round');
        poly.setAttribute('vector-effect', 'non-scaling-stroke');
        poly.style.animationDelay = `${Math.min(order, 8) * 60}ms`;
        overlay.append(poly);
      });
    }

    // Wins are listed as numbers, largest first. No escalation: a large
    // win is a larger number in the same list, drawn the same way.
    function listWins(wins, scatterCells, scatterPay, scale) {
      const list = $('win-list');
      list.textContent = '';
      const shown = wins.slice(0, 5);
      for (const w of shown) {
        list.append(
          el('li', {}, [
            el('span', {
              cls: 'wl-line',
              text: `${t('slot_win_line')} ${w.line + 1}`,
              attrs: { style: `color:hsl(${(w.line * 47) % 360} 92% 64%)` },
            }),
            symbolImg(w.symbol, 'wl-sym'),
            el('span', { cls: 'wl-run num', text: `×${w.run}` }),
            el('span', { cls: 'wl-pay num', text: `${px(w.pay * scale)}×` }),
          ]),
        );
      }
      if (wins.length > shown.length) {
        list.append(el('li', { cls: 'wl-more num', text: `+${wins.length - shown.length}` }));
      }
      if (scatterPay > 0) {
        list.append(
          el('li', {}, [
            el('span', { cls: 'wl-line', dataT: 'slot_scatter' }),
            symbolImg(machine.scatter, 'wl-sym'),
            el('span', { cls: 'wl-run num', text: `×${scatterCells.length}` }),
            el('span', { cls: 'wl-pay num', text: `${px(scatterPay * scale)}×` }),
          ]),
        );
      }
    }

    async function landLadder(outcome, art) {
      const shown = outcome.reels;
      for (let i = 0; i < cells.length; i++) {
        cells[i].classList.remove('spinning');
        cells[i].textContent = art.symbols[shown[i]] ?? '?';
        cells[i].classList.add('landed');
        kit.reel(i, cells.length);
        if (i < cells.length - 1) await sleep(art.gap);
      }
      if (outcome.mult > 0) for (const cell of cells) cell.classList.add('matched');
    }

    async function landLines(outcome, art) {
      // Rebuilt from the committed stops with the verifier's own module.
      // The round carries the RTP it was resolved at, so an admin who
      // changes the setting mid-session cannot make this page price a
      // round against a number that was not in force when it was played.
      const grid = lineGrid(outcome.stops, spec);
      const evalv = lineEvaluate(grid, spec);
      const scale = linePayScale(outcome.rtp ?? config.rtp, machine.id);

      for (let c = 0; c < machine.cols; c++) {
        for (let r = 0; r < machine.rows; r++) {
          const { face, img } = gcells[c][r];
          face.classList.remove('spinning');
          img.src = artFor(machine.symbols[grid[c][r]]);
          face.classList.add('landed');
        }
        kit.reel(c, machine.cols);
        if (c < machine.cols - 1) await sleep(art.gap);
      }

      // If the grid this page derived ever disagreed with the multiplier
      // the server recorded, drawing wins on it would be drawing a lie.
      // The numbers the server committed to still stand; the highlights
      // are what get dropped.
      const derived = (evalv.total / spec.lines.length) * scale;
      if (Math.abs(derived - outcome.mult) > 1e-9) return;

      const wins = [...evalv.wins].sort((a, b) => b.pay - a.pay);
      for (const w of wins) {
        for (let col = 0; col < w.run; col++) {
          gcells[col][spec.lines[w.line][col]].face.classList.add('won');
        }
      }
      for (const [c, r] of evalv.scatterCells) gcells[c][r].face.classList.add('scattered');
      drawWinLines(wins);
      listWins(wins, evalv.scatterCells, evalv.scatterPay, scale);
    }

    async function spin() {
      if (busy || !machine) return;
      busy = true;
      $('spin-btn').disabled = true;
      bet.setDisabled(true);
      clearReadout();

      const stake = bet.value;
      const art = look(machine);
      const at = machine;
      startShuffle();
      kit.press();
      kit.start();
      const started = Date.now();

      try {
        const res = await api('/api/game/slots/spin', {
          method: 'POST',
          body: { bet: stake, machine: machine.id },
        });

        await sleep(Math.max(0, art.run - (Date.now() - started)));
        stopShuffle();

        // The player can walk to another cabinet while the request is
        // in flight. The round still happened and the balance still
        // moved — but the reels standing there are not this one's, so
        // nothing gets painted onto them.
        if (machine === at) {
          const { outcome } = res.round;
          if (isLines(at)) await landLines(outcome, art);
          else await landLadder(outcome, art);
          kit.stop();

          const { mult } = outcome;
          const net = res.round.payout - stake;
          $('mult-badge').textContent = `${px(mult)}×`;
          const netEl = $('net-value');
          netEl.textContent = net > 0 ? `+${fmt(net)}` : net < 0 ? `−${fmt(-net)}` : '±0';
          netEl.className = `net-value num ${net > 0 ? 'win-text' : net < 0 ? 'lose-text' : ''}`.trim();
          // The same short result tone whatever the size of the win —
          // nothing here gets louder for a bigger number.
          kit.result(net > 0 ? 'win' : net === 0 ? 'even' : 'loss');

          results.unshift({ mult, net });
          if (results.length > 12) results.pop();
          renderStrip();
        }
        updateBalance(res.balance);
      } catch (err) {
        stopShuffle();
        kit.stop();
        stopSpinning();
        toastError(err);
      } finally {
        busy = false;
        $('spin-btn').disabled = false;
        bet.setDisabled(false);
      }
    }

    $('spin-btn').addEventListener('click', spin);
    $('back-btn').addEventListener('click', () => {
      sfx.button();
      location.hash = '';
    });

    // ── routing: /slots#<machine> deep-links straight to a cabinet ──
    function route() {
      const id = location.hash.replace('#', '');
      if (id && byId.has(id)) openMachine(id);
      else showFloor();
    }
    window.addEventListener('hashchange', route);

    onLocaleChange(() => {
      if (machine) {
        paintTitles();
        paintFacts();
        paintPaytable();
      } else {
        renderFloor();
        applyI18n($('floor'));
      }
    });

    route();
  }
}
