import { initShell, toast, toastError } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { sha256Hex, verifySlots, verifyRoulette, ROULETTE_RED } from '../verify-core.js';

const SYMBOLS = ['🍋', '🍒', '🍇', '🔔', '⭐', '💎', '7️⃣', '👑', '🎰'];

// The verifier itself needs no session — anyone holding a revealed
// seed can check a round. Loading a round by ID does need one, since
// rounds are private to their player (or an admin).
await initShell();

const $ = (id) => document.getElementById(id);
let recorded = null; // the loaded round, if any

function pocketLabel(n) {
  if (n === 0) return '0';
  return `${n} · ${t(ROULETTE_RED.has(n) ? 'roulette_red' : 'roulette_black')}`;
}

// One entry per verifiable game. `describe` renders an outcome;
// `compute` recomputes it from the seeds and says whether it matches
// the recorded one.
const GAMES = {
  slots: {
    usesRtp: true,
    describe(outcome) {
      const reels = outcome.reels.map((i) => SYMBOLS[i] ?? '?').join(' ');
      return `${reels}  ·  ${outcome.mult}×`;
    },
    async compute({ serverSeed, clientSeed, nonce, rtp }) {
      const out = await verifySlots({ serverSeed, clientSeed, nonce, rtp });
      return {
        text: this.describe(out),
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
};

function syncGameFields() {
  const game = $('v-game').value;
  $('rtp-row').hidden = !(GAMES[game] && GAMES[game].usesRtp);
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
