import { initShell, state, el, toastError, updateBalance, onLocaleChange } from '../shell.js';
import { api } from '../api.js';
import { fmt, fmtCredits, t, applyI18n } from '../i18n.js';
import { createBetControl } from '../bet.js';
import { sfx, slotKit } from '../sound.js';
import { lineArt, artFor } from '../slot-line-art.js';
import { lineMachine, lineGrid, lineEvaluate, linePayScale } from '../verify-core.js';

// The slots floor. Machines, their paytables and their odds all come
// from the server registry — this page never keeps a second copy of the
// numbers, so what a player reads in the paytable is what the spin was
// resolved against. Symbols, colours, timings and sound are the only
// things chosen here, and none of them can see an outcome before the
// server has already fixed it.
//
// Every cabinet is a payline machine: a grid over fixed reel strips that
// pays each line opening on the leftmost reel. A round records only its
// reel stops, because the grid and every win follow from them. This page
// rebuilds both with the same module the fairness verifier uses, so the
// screen is showing what the committed stops actually mean rather than a
// second telling of it.
//
// The retired ladder cabinets are not rendered here at all. Replaying
// one is /verify's job, and that page keeps its own display table.

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
    const look = (m) => lineArt(m.id);
    // A scaled pay value is rarely a round number. Two decimals is
    // enough to be exact at every RTP the admin can set.
    const px = (v) => fmt(Math.round(v * 100) / 100);

    // One sound kit per machine, built the first time a cabinet opens.
    const kits = new Map();
    const kitFor = (m) => {
      if (!kits.has(m.id)) kits.set(m.id, slotKit(look(m).sound));
      return kits.get(m.id);
    };

    // A cabinet is fronted by the sprite of a symbol that really is on
    // its own reels, rather than a mascot picked to look expensive.
    function paintArt(node, m) {
      node.textContent = '';
      node.append(el('img', {
        cls: 'art-img',
        attrs: { src: artFor(lineArt(m.id).lead), alt: '', draggable: 'false' },
      }));
    }

    function artNode(m) {
      const node = el('span', { cls: 'card-art' });
      paintArt(node, m);
      return node;
    }

    // ── the floor ──────────────────────────────────────────────────
    function statsOf(m) {
      return [
        [`${m.cols}×${m.rows}`, 'slot_fact_grid'],
        [String(m.lines.length), 'slot_fact_lines'],
        [pct(m.hit_rate), 'slot_fact_hit'],
        [`${px(m.top)}×`, 'slot_fact_topline'],
      ];
    }

    function renderFloor() {
      const grid = $('slot-grid');
      grid.textContent = '';
      for (const m of config.machines) {
        grid.append(
          el('button', {
            cls: 'slot-card lines',
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
    let spec = null;    // the browser's own copy of the reel strips
    let kit = null;
    let gcells = [];    // [col][row] → { face, img }
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
      const rows = [
        ['slot_fact_grid', `${machine.cols}×${machine.rows}`],
        ['slot_fact_lines', String(machine.lines.length)],
        ['slot_fact_hit', pct(machine.hit_rate)],
        ['slot_fact_topline', `${px(machine.top)}×`],
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
    function paintPaytable() {
      if (!machine) return;
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

    function paintTitles() {
      if (!machine) return;
      paintArt($('cab-art'), machine);
      $('cab-name').textContent = nameOf(machine);
      $('cab-sub').textContent = t(`slot_tag_${machine.id}`);
      const vol = $('cab-vol');
      vol.className = `vol-badge vol-${machine.volatility}`;
      vol.textContent = t(volKey(machine));
    }

    // The grid has no gaps: each cell holds an inset face, so the SVG
    // overlay's viewBox of one unit per cell lands a payline exactly on
    // the centres it passes through, at any size and without measuring.
    //
    // Idle faces are a fixed pattern, not a random draw — nothing on
    // this page is allowed to look like it produced a result.
    function buildGrid() {
      const wrap = $('reel-grid');
      const overlay = $('line-overlay');
      wrap.textContent = '';
      wrap.append(overlay);
      wrap.style.setProperty('--cols', String(machine.cols));
      wrap.style.setProperty('--rows', String(machine.rows));
      overlay.setAttribute('viewBox', `0 0 ${machine.cols} ${machine.rows}`);
      gcells = [];
      for (let c = 0; c < machine.cols; c++) {
        const column = [];
        for (let r = 0; r < machine.rows; r++) {
          const index = (c * 3 + r * 5 + 1) % machine.symbols.length;
          const img = el('img', {
            attrs: { src: artFor(machine.symbols[index]), alt: '', draggable: 'false' },
          });
          const face = el('span', { cls: 'gface' }, [img]);
          const cell = el('div', { cls: 'gcell' }, [face]);
          // Placed through the CSSOM, not a style="" attribute. The site
          // ships style-src 'self' with no 'unsafe-inline', which blocks
          // style attributes outright — and this grid is filled column by
          // column, so with the placement dropped the browser auto-flowed
          // the cells row by row and the whole picture came out
          // transposed: the symbol drawn at a position was not the symbol
          // the server had rolled there, and a payline traced cells that
          // visibly held something else. A property assignment is not
          // covered by the directive and cannot be silently ignored.
          cell.style.gridArea = `${r + 1}/${c + 1}`;
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
      $('readout').className = 'cab-readout';
      $('ro-label').textContent = '';
      $('ro-amount').textContent = '';
      $('mult-badge').textContent = '';
      $('ro-net').textContent = '';
      $('win-list').textContent = '';
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
      spec = lineMachine(machine.id);
      if (kit) kit.stop();
      // A spin still in flight leaves the tumble running on a timer. It
      // writes into whatever `gcells` holds, so left alone it would go on
      // to scribble the last cabinet's sprites across this one's fresh
      // reels and abandon them there — the request that started it is no
      // longer going to paint anything.
      stopShuffle();
      kit = kitFor(machine);
      results.length = 0;

      const cab = $('cab');
      cab.dataset.machine = machine.id;
      cab.dataset.land = look(machine).land;
      // Swapping a sprite in mid-tumble must not wait on the network.
      for (const key of machine.symbols) new Image().src = artFor(key);
      buildGrid();
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
      stopShuffle();
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
    }

    function stopShuffle() {
      clearInterval(shuffleTimer);
      shuffleTimer = null;
    }

    function stopSpinning() {
      for (const column of gcells) for (const { face } of column) face.classList.remove('spinning');
    }

    // One polyline per winning line, over the cells the run actually
    // covers. Colours are a function of the line index so two lines that
    // overlap stay tellable apart, and the stroke is non-scaling so the
    // stretched viewBox cannot make it thicker one way than the other.
    // Coloured by the order the lines are drawn in, not by line index.
    // Indexing by line looked stable, but lines that land together tend
    // to be close-numbered, and 47 degrees per index wraps: line 9 and
    // line 17 on the twenty-line cabinet came out 16 degrees apart —
    // the same orange twice, over the same reels. Only the lines on
    // screen at once ever need telling apart, and the golden angle
    // spreads however many of them there are about as evenly as they
    // can be spread. The win list numbers itself the same way, so a row
    // there and a stroke here carry one colour between them.
    const hueFor = (order) => `hsl(${(order * 137.508) % 360} 92% 64%)`;

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
        poly.setAttribute('stroke', hueFor(order));
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
    //
    // In credits, not multipliers. Every one of these used to be printed
    // with a "×" and so did the total, but they were not the same unit:
    // a line pays a multiple of the *line* bet while the total is a
    // multiple of the whole stake. On the thirty-line cabinet at 100 a
    // credit, that showed "54.92×" over a line and "2.1×" for the spin
    // and left no way to get from one to the other. Credits are the unit
    // the player is actually paid in, and they add up to the headline.
    function listWins(wins, scatterCells, scatterPay, scale, stake, atSpec) {
      const list = $('win-list');
      list.textContent = '';
      const lineBet = stake / atSpec.lines.length;
      const shown = wins.slice(0, 5);
      shown.forEach((w, order) => {
        // Same hue as the stroke over the reels, so a row here and a line
        // up there are matchable at a glance. Set through the CSSOM for
        // the same reason as the grid cells: style attributes are blocked.
        const label = el('span', { cls: 'wl-line', text: `${t('slot_win_line')} ${w.line + 1}` });
        label.style.color = hueFor(order);
        list.append(
          el('li', {}, [
            label,
            symbolImg(w.symbol, 'wl-sym'),
            el('span', { cls: 'wl-run num', text: `×${w.run}` }),
            // A share of the stake, so it lands between hundredths more
            // often than not; printed to the hundredth, which is as fine
            // as the money itself goes. The rounded shares need not sum
            // to the last hundredth of the headline, which is settled
            // once from the total multiplier rather than line by line.
            el('span', { cls: 'wl-pay num', text: fmtCredits(w.pay * scale * lineBet) }),
          ]),
        );
      });
      if (wins.length > shown.length) {
        list.append(el('li', { cls: 'wl-more num', text: `+${wins.length - shown.length}` }));
      }
      if (scatterPay > 0) {
        list.append(
          el('li', {}, [
            el('span', { cls: 'wl-line', dataT: 'slot_scatter' }),
            symbolImg(machine.scatter, 'wl-sym'),
            el('span', { cls: 'wl-run num', text: `×${scatterCells.length}` }),
            // the scatter is quoted against the whole stake, not a line
            el('span', { cls: 'wl-pay num', text: fmtCredits(scatterPay * scale * stake) }),
          ]),
        );
      }
    }

    // `at` is the cabinet that spun, and `atSpec` its strips. Both are
    // taken as arguments rather than read off the module, because the
    // reels land one column at a time and a player can walk to another
    // cabinet in the middle of that — at which point the globals are
    // already describing a different machine.
    async function landLines(outcome, art, stake, at, atSpec) {
      // Rebuilt from the committed stops with the verifier's own module.
      // The round carries the RTP it was resolved at, so an admin who
      // changes the setting mid-session cannot make this page price a
      // round against a number that was not in force when it was played.
      const grid = lineGrid(outcome.stops, atSpec);
      const evalv = lineEvaluate(grid, atSpec);
      const scale = linePayScale(outcome.rtp ?? config.rtp, at.id);

      for (let c = 0; c < at.cols; c++) {
        for (let r = 0; r < at.rows; r++) {
          const { face, img } = gcells[c][r];
          face.classList.remove('spinning');
          img.src = artFor(at.symbols[grid[c][r]]);
          face.classList.add('landed');
        }
        kit.reel(c, at.cols);
        if (c < at.cols - 1) {
          await sleep(art.gap);
          // Gone. `gcells` is whatever cabinet is open now, so finishing
          // here would paint one machine's outcome onto another's reels.
          if (machine !== at) return;
        }
      }

      // If the grid this page derived ever disagreed with the multiplier
      // the server recorded, drawing wins on it would be drawing a lie.
      // The numbers the server committed to still stand; the highlights
      // are what get dropped.
      const derived = (evalv.total / atSpec.lines.length) * scale;
      if (Math.abs(derived - outcome.mult) > 1e-9) return;

      const wins = [...evalv.wins].sort((a, b) => b.pay - a.pay);
      for (const w of wins) {
        for (let col = 0; col < w.run; col++) {
          gcells[col][atSpec.lines[w.line][col]].face.classList.add('won');
        }
      }
      // Only a scatter that actually paid is lit. One or two of them land
      // on about half of every machine's spins and pay nothing at all —
      // ringing those was decorating a loss to look like it came close,
      // which is the one thing this floor will not do. It also simply
      // wasn't true: the highlight means "this cell won something", and
      // on those spins it didn't.
      if (evalv.scatterPay > 0) {
        for (const [c, r] of evalv.scatterCells) gcells[c][r].face.classList.add('scattered');
      }
      drawWinLines(wins);
      listWins(wins, evalv.scatterCells, evalv.scatterPay, scale, stake, atSpec);
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
      const atSpec = spec;
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

        // The player can walk to another cabinet while the request is in
        // flight, and again while the reels are still landing — they land
        // a column at a time. The round still happened and the balance
        // still moved, but the grid standing there is not this one's, so
        // nothing gets painted onto it. Both crossings are checked:
        // `landLines` gives up mid-landing, and the readout is written
        // only if the cabinet is still the one that spun.
        const { outcome } = res.round;
        if (machine === at) await landLines(outcome, art, stake, at, atSpec);
        if (machine === at) {
          kit.stop();

          // How much came back, said plainly and in one place. The
          // readout used to lead with the multiplier and put the net
          // beside it, which answered "how did this spin price" but not
          // "what did I win" — and the two numbers were in different
          // units besides. The credits are the headline now; the
          // multiplier and the net sit underneath as the working.
          const { mult } = outcome;
          const { payout } = res.round;
          const net = payout - stake;
          const kind = net > 0 ? 'win' : net < 0 ? 'lose' : 'even';
          $('readout').className = `cab-readout shown ${kind}`;
          $('ro-label').textContent = t(`slot_${kind === 'win' ? 'won' : kind === 'lose' ? 'lost' : 'even'}_label`);
          // On a win or a push the headline is what came back. On a loss
          // it is what the spin cost — a partial return is still a loss,
          // and printing the 40 that came back off a 100 stake as though
          // it were the result would be the wrong number in bold.
          $('ro-amount').textContent = net < 0 ? `−${fmtCredits(-net)}` : fmtCredits(payout);
          $('mult-badge').textContent = `${px(mult)}×`;
          $('ro-net').textContent = net > 0 ? `+${fmtCredits(net)}` : net < 0 ? '' : '±0';
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
