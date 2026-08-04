import { initShell, toast, toastError, onLocaleChange } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import {
  sha256Hex,
  verifySlots,
  verifyRoulette,
  verifyDice,
  verifyBlackjack,
  verifyBlackjackTable,
  bjHandTotal,
  ROULETTE_RED,
  SLOT_MACHINE_IDS,
  SLOT_DEFAULT_MACHINE,
  verifySlotLines,
  isLineMachine,
  LINE_MACHINE_IDS,
} from '../verify-core.js';
import { theme } from '../slot-themes.js';

// The verifier itself needs no session — anyone holding a revealed
// seed can check a round. Loading a round by ID does need one, since
// rounds are private to their player (or an admin).
await initShell();

const $ = (id) => document.getElementById(id);
let recorded = null; // the loaded round, if any

// A payline multiplier is a scaled sum rather than a value off a ladder,
// so it is rarely a round number. Trim it for display without hiding a
// difference that would matter.
const round4 = (n) => String(Math.round(n * 10000) / 10000);

function pocketLabel(n) {
  if (n === 0) return '0';
  return `${n} · ${t(ROULETTE_RED.has(n) ? 'roulette_red' : 'roulette_black')}`;
}

// One entry per verifiable game. `describe` renders an outcome;
// `compute` recomputes it from the seeds and says whether it matches
// the recorded one.
const GAMES = {
  // Two engines behind one game name. A ladder round is a multiplier and
  // a row of symbols; a payline round is a set of reel stops that the
  // grid and every winning line are derived from. The recorded outcome
  // says which it is, and only the stops are stored, so the check is
  // against the numbers the server actually committed to.
  slots: {
    usesRtp: true,
    describe(outcome, machine) {
      const id = machine || outcome.machine;
      if (isLineMachine(id)) {
        const wins = outcome.wins ? outcome.wins.length : null;
        const parts = [outcome.stops.join(', ')];
        if (wins !== null) parts.push(`${wins} ${t('verify_line_wins')}`);
        parts.push(`${round4(outcome.mult)}×`);
        return parts.join('  ·  ');
      }
      const syms = theme(id).symbols;
      const reels = outcome.reels.map((i) => syms[i] ?? '?').join(' ');
      return `${reels}  ·  ${outcome.mult}×`;
    },
    async compute({ serverSeed, clientSeed, nonce, rtp }) {
      const machine = $('v-machine').value;
      if (isLineMachine(machine)) {
        const out = await verifySlotLines({ serverSeed, clientSeed, nonce, rtp, machine });
        return {
          text: this.describe(out, machine),
          matches: recorded
            ? JSON.stringify(out.stops) === JSON.stringify(recorded.outcome.stops) &&
              // the multiplier is a scaled sum, so compare it as a number
              Math.abs(out.mult - recorded.outcome.mult) < 1e-9
            : null,
        };
      }
      const out = await verifySlots({ serverSeed, clientSeed, nonce, rtp, machine });
      return {
        text: this.describe(out, machine),
        matches: recorded
          ? out.mult === recorded.outcome.mult &&
            JSON.stringify(out.reels) === JSON.stringify(recorded.outcome.reels)
          : null,
      };
    },
  },
  roulette: {
    usesRtp: false,
    describe(outcome) {
      return pocketLabel(outcome.number);
    },
    async compute({ serverSeed, clientSeed, nonce }) {
      const bets = recorded ? recorded.outcome.bets : [];
      const out = await verifyRoulette({ serverSeed, clientSeed, nonce, bets });
      let text = pocketLabel(out.number);
      if (bets.length) text += `  ·  ${fmt(out.payout)}`;
      return {
        text,
        matches: recorded
          ? out.number === recorded.outcome.number && out.payout === recorded.payout
          : null,
      };
    },
  },
  dice: {
    usesRtp: true,
    describe(outcome) {
      const arrow = outcome.direction === 'under' ? '<' : '>';
      return `${outcome.roll.toFixed(2)} ${arrow} ${outcome.target} · ${outcome.win ? '✓' : '✗'}`;
    },
    async compute({ serverSeed, clientSeed, nonce, rtp }) {
      if (!recorded || recorded.game !== 'dice') return { text: '—', matches: null };
      const { target, direction } = recorded.outcome;
      const out = await verifyDice({ serverSeed, clientSeed, nonce, rtp, target, direction });
      const arrow = direction === 'under' ? '<' : '>';
      return {
        text: `${out.r.toFixed(2)} ${arrow} ${target} · ${out.win ? '✓' : '✗'}`,
        matches:
          out.r === recorded.outcome.roll && out.win === recorded.outcome.win,
      };
    },
  },
  blackjack: {
    usesRtp: false,
    describe(outcome) {
      const cards = (hand) =>
        hand
          .map((c) => `${['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][c % 13]}${['♠', '♥', '♦', '♣'][Math.floor(c / 13)]}`)
          .join(' ');
      return `${cards(outcome.player)} (${bjHandTotal(outcome.player).total}) — ${cards(outcome.dealer)} (${bjHandTotal(outcome.dealer).total})`;
    },
    async compute({ serverSeed, clientSeed, nonce }) {
      if (!recorded || recorded.game !== 'blackjack') return { text: '—', matches: null };
      // shared-table rounds use per-seat streams; single-hand rounds
      // use the interleaved player/dealer stream.
      const out = recorded.outcome.table
        ? await verifyBlackjackTable({
            serverSeed,
            nonce,
            seat: recorded.outcome.seat,
            actions: recorded.outcome.actions,
          })
        : await verifyBlackjack({ serverSeed, clientSeed, nonce, actions: recorded.outcome.actions });
      return {
        text: this.describe(out),
        matches:
          JSON.stringify(out.player) === JSON.stringify(recorded.outcome.player) &&
          JSON.stringify(out.dealer) === JSON.stringify(recorded.outcome.dealer),
      };
    },
  },
};

// Each slot machine resolves its draw against its own paytable, so the
// verifier needs to know which cabinet a round was played on.
const machineSelect = $('v-machine');
const FLOOR_IDS = [...LINE_MACHINE_IDS, ...SLOT_MACHINE_IDS];
for (const id of FLOOR_IDS) machineSelect.append(new Option(t(`slot_name_${id}`), id));
machineSelect.value = SLOT_DEFAULT_MACHINE;
onLocaleChange(() => {
  for (const option of machineSelect.options) option.textContent = t(`slot_name_${option.value}`);
});

function syncGameFields() {
  const game = $('v-game').value;
  $('rtp-row').hidden = !(GAMES[game] && GAMES[game].usesRtp);
  $('machine-row').hidden = game !== 'slots';
}
$('v-game').addEventListener('change', syncGameFields);
syncGameFields();

async function loadRound(id) {
  try {
    const res = await api(`/api/rounds/${encodeURIComponent(id)}`);
    const round = res.round;
    if (!GAMES[round.game]) {
      toast('err_validation');
      return;
    }
    $('v-game').value = round.game;
    syncGameFields();
    $('v-client-seed').value = round.client_seed;
    $('v-nonce').value = String(round.nonce);
    if (round.outcome.rtp !== undefined) $('v-rtp').value = String(round.outcome.rtp);
    if (round.game === 'slots') {
      $('v-machine').value = round.outcome.machine || SLOT_DEFAULT_MACHINE;
    }
    if (round.server_seed) {
      $('v-server-seed').value = round.server_seed;
    } else {
      $('v-server-seed').value = '';
      toast('verify_not_revealed');
    }
    recorded = {
      game: round.game,
      outcome: round.outcome,
      server_seed_hash: round.server_seed_hash,
      bet: round.bet,
      payout: round.payout,
    };
    $('recorded-wrap').hidden = false;
    $('recorded-result').textContent =
      `${GAMES[round.game].describe(round.outcome)}  ·  ${fmt(round.payout)}`;
  } catch (err) {
    recorded = null;
    toastError(err);
  }
}

$('load-round').addEventListener('click', () => {
  const id = $('round-id').value.trim();
  if (id) loadRound(id);
});

$('compute').addEventListener('click', async () => {
  const game = $('v-game').value;
  const serverSeed = $('v-server-seed').value.trim();
  const clientSeed = $('v-client-seed').value.trim();
  const nonce = Number($('v-nonce').value);
  const rtp = Number($('v-rtp').value);
  if (!GAMES[game] || !serverSeed || !clientSeed || !Number.isInteger(nonce) || nonce < 0) {
    toast('err_validation');
    return;
  }

  const hash = await sha256Hex(serverSeed);
  $('computed-hash').textContent = hash;
  const hashVerdict = $('hash-verdict');
  hashVerdict.textContent = '';
  hashVerdict.className = 'hash-verdict';
  let hashOk = null;
  if (recorded) {
    hashOk = hash === recorded.server_seed_hash;
    hashVerdict.textContent = t(hashOk ? 'verify_hash_match' : 'verify_hash_mismatch');
    hashVerdict.classList.add(hashOk ? 'win-text' : 'lose-text');
  }

  const computed = await GAMES[game].compute({ serverSeed, clientSeed, nonce, rtp });
  $('computed-result').textContent = computed.text;
  $('output').hidden = false;

  const verdict = $('verdict');
  if (recorded && recorded.game === game && computed.matches !== null) {
    const same = computed.matches && hashOk === true;
    verdict.hidden = false;
    verdict.textContent = t(same ? 'verify_match' : 'verify_mismatch');
    verdict.className = `verdict ${same ? 'ok' : 'bad'}`;
  } else {
    verdict.hidden = true;
  }
});

const params = new URLSearchParams(location.search);
if (params.get('round')) {
  $('round-id').value = params.get('round');
  await loadRound(params.get('round'));
}
