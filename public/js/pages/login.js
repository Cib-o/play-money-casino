import { initShell, toastError, state } from '../shell.js';
import { api } from '../api.js';

await initShell();

// The server redirects authenticated visitors off /login, but the raw
// /login.html file is also reachable through the static handler — so
// the client repeats the check.
if (state.me) {
  location.href = state.me.role === 'admin' ? '/admin' : '/';
}

const form = document.getElementById('login-form');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const res = await api('/api/login', {
      method: 'POST',
      body: {
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
      },
    });
    location.href = res.user.role === 'admin' ? '/admin' : '/';
  } catch (err) {
    toastError(err);
    button.disabled = false;
  }
});
