import { initShell, el, toast, toastError, state } from '../shell.js';
import { api } from '../api.js';
import { CREDIT } from '../i18n.js';

const ctx = await initShell({ requireAuth: 'admin' });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let settings = await api('/api/admin/settings');

  // The API carries hundredths; the operator types credits. These are
  // the only two places on the page where the two units meet, and the
  // rounding on the way in is what keeps 0.07 from arriving as 6.999.
  const toCredits = (units) => (units / CREDIT).toFixed(2);
  const toUnits = (id) => Math.round(Number($(id).value) * CREDIT);

  function fill() {
    $('s-rtp').value = settings.rtp;
    $('s-site').value = settings.site_name;
    $('s-min').value = toCredits(settings.min_bet);
    $('s-max').value = toCredits(settings.max_bet);
    $('s-balance').value = toCredits(settings.default_balance);
    $('s-locale').value = settings.default_locale;
    $('s-maxbots').value = settings.blackjack_max_bots;

    const wrap = $('games-toggles');
    wrap.textContent = '';
    for (const [game, enabled] of Object.entries(settings.games)) {
      const input = el('input', { attrs: { type: 'checkbox', id: `g-${game}` } });
      input.checked = enabled;
      wrap.append(
        el('label', { cls: 'chip-toggle', attrs: { for: `g-${game}` } }, [
          input,
          el('span', { dataT: `game_${game}` }),
        ]),
      );
    }
  }
  fill();

  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const games = {};
    for (const game of Object.keys(settings.games)) {
      games[game] = $(`g-${game}`).checked;
    }
    try {
      settings = await api('/api/admin/settings', {
        method: 'POST',
        body: {
          rtp: Number($('s-rtp').value),
          site_name: $('s-site').value.trim(),
          min_bet: toUnits('s-min'),
          max_bet: toUnits('s-max'),
          default_balance: toUnits('s-balance'),
          default_locale: $('s-locale').value,
          blackjack_max_bots: Number($('s-maxbots').value),
          games,
        },
      });
      fill();
      toast('adm_saved', 'ok');
      // Keep the header brand in sync with a renamed platform.
      if (state.pub) state.pub.site_name = settings.site_name;
      const brand = document.getElementById('brand-name');
      if (brand) brand.textContent = settings.site_name;
    } catch (err) {
      toastError(err);
    }
  });

  // ── danger zone ───────────────────────────────────────────────────
  // The word the server insists on (src/routes/admin.js). This copy
  // cannot drift silently: send anything else and the request is
  // refused, so a mismatch shows up the first time the button is used
  // rather than wiping a floor on the strength of the wrong token.
  const RESET_TOKEN = 'RESET';

  const resetDialog = $('reset-dialog');
  const resetInput = $('reset-token');
  const resetConfirm = $('reset-confirm');
  $('reset-word').textContent = RESET_TOKEN;

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }

  // Typing the word is the whole guard, so the button stays dead until
  // it matches: the second click is never in the same place as the
  // first, and no amount of pressing Enter arrives here on its own.
  resetInput.addEventListener('input', () => {
    resetConfirm.disabled = resetInput.value.trim() !== RESET_TOKEN;
  });

  $('reset-open').addEventListener('click', () => {
    resetInput.value = '';
    resetConfirm.disabled = true;
    resetDialog.showModal();
  });

  resetConfirm.addEventListener('click', async () => {
    resetConfirm.disabled = true;
    try {
      await api('/api/admin/reset', { method: 'POST', body: { confirm: RESET_TOKEN } });
      resetDialog.close();
      toast('adm_reset_done', 'ok');
    } catch (err) {
      resetConfirm.disabled = false;
      toastError(err);
    }
  });
}
