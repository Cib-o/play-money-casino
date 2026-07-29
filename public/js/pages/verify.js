import { initShell, toast, toastError } from '../shell.js';
import { api } from '../api.js';
import { t, fmt } from '../i18n.js';
import { sha256Hex, verifySlots } from '../verify-core.js';

const SYMBOLS = ['🍋', '🍒', '🍇', '🔔', '⭐', '💎', '7️⃣', '👑', '🎰'];

// The verifier itself needs no session — anyone holding a revealed
// seed can check a round. Loading a round by ID does need one, since
// rounds are private to their player (or an admin).
await initShell();

const $ = (id) => document.getElementById(id);
let recorded = null; // outcome of the loaded round, if any

function describeSlots(outcome) {
  const reels = outcome.reels.map((i) => SYMBOLS[i] ?? '?').join(' ');
  return `${reels}  ·  ${outcome.mult}×`;
}

async function loadRound(id) {
  try {
    const res = await api(`/api/rounds/${encodeURIComponent(id)}`);
    const round = res.round;
    $('v-game').value = round.game;
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
      describeSlots(round.outcome) + `  ·  ${fmt(round.payout)}`;
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
  const serverSeed = $('v-server-seed').value.trim();
  const clientSeed = $('v-client-seed').value.trim();
  const nonce = Number($('v-nonce').value);
  const rtp = Number($('v-rtp').value);
  if (!serverSeed || !clientSeed || !Number.isInteger(nonce) || nonce < 0) {
    toast('err_validation');
    return;
  }

  const hash = await sha256Hex(serverSeed);
  $('computed-hash').textContent = hash;
  const hashVerdict = $('hash-verdict');
  hashVerdict.textContent = '';
  hashVerdict.className = 'hash-verdict';
  if (recorded) {
    const ok = hash === recorded.server_seed_hash;
    hashVerdict.textContent = t(ok ? 'verify_hash_match' : 'verify_hash_mismatch');
    hashVerdict.classList.add(ok ? 'win-text' : 'lose-text');
  }

  const computed = await verifySlots({ serverSeed, clientSeed, nonce, rtp });
  $('computed-result').textContent = describeSlots(computed);
  $('output').hidden = false;

  const verdict = $('verdict');
  if (recorded && recorded.game === 'slots') {
    const same =
      computed.mult === recorded.outcome.mult &&
      JSON.stringify(computed.reels) === JSON.stringify(recorded.outcome.reels) &&
      hash === recorded.server_seed_hash;
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
