import { initShell, state, toast, toastError } from '../shell.js';
import { api } from '../api.js';
import { setLocale, getLocale } from '../i18n.js';

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  $('p-display').value = state.me.display_name;
  $('p-locale').value = state.me.locale;

  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const locale = $('p-locale').value;
    try {
      const res = await api('/api/profile', {
        method: 'POST',
        body: { display_name: $('p-display').value.trim(), locale },
      });
      state.me = { ...state.me, ...res.user };
      if (locale !== getLocale()) {
        setLocale(locale);
        for (const btn of document.querySelectorAll('.lang-switch button')) {
          btn.setAttribute('aria-pressed', String(btn.dataset.lang === locale));
        }
      }
      toast('adm_saved', 'ok');
    } catch (err) {
      toastError(err);
    }
  });

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = $('p-current').value;
    const next = $('p-new').value;
    if (next.length < 8) {
      toast('err_weak_password');
      return;
    }
    try {
      await api('/api/password', { method: 'POST', body: { current, next } });
      $('p-current').value = '';
      $('p-new').value = '';
      toast('prof_password_changed', 'ok');
    } catch (err) {
      toastError(err);
    }
  });
}
