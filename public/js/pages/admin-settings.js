import { initShell, el, toast, toastError, state } from '../shell.js';
import { api } from '../api.js';

const ctx = await initShell({ requireAuth: 'admin' });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let settings = await api('/api/admin/settings');

  function fill() {
    $('s-rtp').value = settings.rtp;
    $('s-site').value = settings.site_name;
    $('s-min').value = settings.min_bet;
    $('s-max').value = settings.max_bet;
    $('s-balance').value = settings.default_balance;
    $('s-locale').value = settings.default_locale;

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
          min_bet: Number($('s-min').value),
          max_bet: Number($('s-max').value),
          default_balance: Number($('s-balance').value),
          default_locale: $('s-locale').value,
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
}
