import { initShell, state, el, toastError, updateBalance, onLocaleChange } from '../shell.js';
import { api } from '../api.js';
import { fmt, t, applyI18n } from '../i18n.js';
import { createBetControl } from '../bet.js';
import { sfx, slotKit } from '../sound.js';
import { theme } from '../slot-themes.js';

// The slots floor. Machines, their paytables and their odds all come
// from the server registry — this page never keeps a second copy of the
// numbers, so what a player reads in the paytable is what the spin was
// resolved against. Symbols, colours, timings and sound are the only
// things chosen here, and none of them can see an outcome before the
// server has already fixed it.

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    // One sound kit per machine, built the first time a cabinet opens.
    const kits = new Map();
    const kitFor = (id) => {
      if (!kits.has(id)) kits.set(id, slotKit(theme(id).sound));
      return kits.get(id);
    };

    // ── the floor ──────────────────────────────────────────────────
    function renderFloor() {
      const grid = $('slot-grid');
      grid.textContent = '';
      for (const m of config.machines) {
        const art = theme(m.id).art;
        grid.append(
          el('button', {
            cls: 'slot-card',
            attrs: { type: 'button', 'data-machine': m.id },
            on: {
              click: () => {
                sfx.button();
                location.hash = m.id;
              },
            },
          }, [
            el('span', { cls: 'card-art', text: art }),
            el('span', { cls: 'card-name', text: nameOf(m) }),
            el('span', { cls: 'card-tag', dataT: `slot_tag_${m.id}` }),
            el('span', { cls: 'card-stats' }, [
              el('span', { cls: 'stat' }, [
                el('em', { text: String(m.reels) }),
                el('i', { dataT: 'slot_fact_reels' }),
              ]),
              el('span', { cls: 'stat' }, [
                el('em', { text: pct(m.hit_rate) }),
                el('i', { dataT: 'slot_fact_hit' }),
              ]),
              el('span', { cls: 'stat' }, [
                el('em', { text: `${fmt(m.top)}×` }),
                el('i', { dataT: 'slot_fact_top' }),
              ]),
            ]),
            el('span', { cls: `vol-badge vol-${m.volatility}`, dataT: volKey(m) }),
            el('span', { cls: 'card-glow' }),
          ]),
        );
      }
    }

    // ── the cabinet ────────────────────────────────────────────────
    let machine = null; // the open machine's server view
    let kit = null;
    let cells = [];
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

    function paintPaytable() {
      if (!machine) return;
      const syms = theme(machine.id).symbols;
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

    function paintTitles() {
      if (!machine) return;
      $('cab-art').textContent = theme(machine.id).art;
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
      row.dataset.count = String(machine.reels);
      for (let i = 0; i < machine.reels; i++) {
        const cell = el('div', { cls: 'reel', text: idleSymbol(i) });
        row.append(cell);
        cells.push(cell);
      }
    }

    function renderStrip() {
      const strip = $('strip');
      strip.textContent = '';
      for (const r of results) {
        strip.append(
          el('span', {
            cls: `cell ${r.net > 0 ? 'win' : r.net < 0 ? 'lose' : ''}`.trim(),
            text: `${fmt(r.mult)}×`,
          }),
        );
      }
    }

    function clearReadout() {
      $('mult-badge').textContent = '';
      $('net-value').textContent = '';
      $('net-value').className = 'net-value num';
      for (const cell of cells) cell.classList.remove('matched', 'landed');
    }

    function openMachine(id) {
      machine = byId.get(id);
      if (!machine) {
        location.hash = '';
        return;
      }
      kit = kitFor(machine.id);
      results.length = 0;

      const cab = $('cab');
      cab.dataset.machine = machine.id;
      cab.dataset.land = theme(machine.id).land;
      buildReels();
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

    async function spin() {
      if (busy || !machine) return;
      busy = true;
      $('spin-btn').disabled = true;
      bet.setDisabled(true);
      clearReadout();

      const stake = bet.value;
      const look = theme(machine.id);
      startShuffle();
      kit.press();
      kit.start();
      const started = Date.now();

      try {
        const res = await api('/api/game/slots/spin', {
          method: 'POST',
          body: { bet: stake, machine: machine.id },
        });

        await sleep(Math.max(0, look.run - (Date.now() - started)));
        stopShuffle();

        const shown = res.round.outcome.reels;
        for (let i = 0; i < cells.length; i++) {
          cells[i].classList.remove('spinning');
          cells[i].textContent = look.symbols[shown[i]] ?? '?';
          cells[i].classList.add('landed');
          kit.reel(i, cells.length);
          if (i < cells.length - 1) await sleep(look.gap);
        }
        kit.stop();

        const { mult } = res.round.outcome;
        const net = res.round.payout - stake;
        if (mult > 0) for (const cell of cells) cell.classList.add('matched');

        $('mult-badge').textContent = `${fmt(mult)}×`;
        const netEl = $('net-value');
        netEl.textContent = net > 0 ? `+${fmt(net)}` : net < 0 ? `−${fmt(-net)}` : '±0';
        netEl.className = `net-value num ${net > 0 ? 'win-text' : net < 0 ? 'lose-text' : ''}`.trim();
        kit.result(net > 0 ? 'win' : net === 0 ? 'even' : 'loss');

        results.unshift({ mult, net });
        if (results.length > 12) results.pop();
        renderStrip();
        updateBalance(res.balance);
      } catch (err) {
        stopShuffle();
        kit.stop();
        for (const cell of cells) cell.classList.remove('spinning');
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
