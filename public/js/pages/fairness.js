import { initShell, state, toast, toastError, copyText } from '../shell.js';
import { api } from '../api.js';

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);

  function renderSeed(seed) {
    $('hash').textContent = seed.server_seed_hash;
    $('client-seed').value = seed.client_seed;
    $('nonce').textContent = String(seed.nonce);
  }

  renderSeed(await api('/api/seed'));
  $('rtp').textContent = state.pub ? String(state.pub.rtp) : '';

  $('save-client').addEventListener('click', async () => {
    const value = $('client-seed').value.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      toast('err_validation');
      return;
    }
    try {
      renderSeed(await api('/api/seed/client', { method: 'POST', body: { client_seed: value } }));
      toast('adm_saved', 'ok');
    } catch (err) {
      toastError(err);
    }
  });

  $('rotate').addEventListener('click', async () => {
    try {
      const res = await api('/api/seed/rotate', { method: 'POST' });
      renderSeed({
        server_seed_hash: res.server_seed_hash,
        client_seed: res.client_seed,
        nonce: res.nonce,
      });
      $('revealed-seed').textContent = res.revealed_server_seed;
      $('revealed-hash').textContent = res.revealed_hash;
      $('copy-revealed').onclick = () => copyText(res.revealed_server_seed);
      $('revealed-panel').hidden = false;
    } catch (err) {
      toastError(err);
    }
  });
}
