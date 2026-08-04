import { initShell, el, toastError, onLocaleChange } from '../shell.js';
import { api } from '../api.js';
import { fmtCredits, fmtDate } from '../i18n.js';

const ctx = await initShell({ requireAuth: 'admin' });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let page = 1;
  let pages = 1;

  async function load() {
    const res = await api(`/api/admin/audit?page=${page}`);
    pages = res.pages;
    const body = $('audit-body');
    body.textContent = '';
    $('audit-empty').hidden = res.total > 0;
    for (const a of res.items) {
      body.append(
        el('tr', {}, [
          el('td', { text: fmtDate(a.created_at) }),
          el('td', { text: a.player_username }),
          el('td', { cls: 'muted', text: a.admin_username }),
          el('td', { cls: 'num', text: fmtCredits(a.before) }),
          el('td', {
            cls: `num ${a.delta >= 0 ? 'win-text' : 'lose-text'}`,
            text: (a.delta >= 0 ? '+' : '') + fmtCredits(a.delta),
          }),
          el('td', { cls: 'num', text: fmtCredits(a.after) }),
          el('td', { cls: 'muted', text: a.note }),
        ]),
      );
    }
    $('page-info').textContent = `${page} / ${pages}`;
    $('prev').disabled = page <= 1;
    $('next').disabled = page >= pages;
  }

  $('prev').addEventListener('click', () => {
    if (page > 1) {
      page--;
      load().catch(toastError);
    }
  });
  $('next').addEventListener('click', () => {
    if (page < pages) {
      page++;
      load().catch(toastError);
    }
  });

  onLocaleChange(() => load().catch(() => {}));
  await load();
}
