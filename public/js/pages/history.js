import { initShell, el, toastError, onLocaleChange } from '../shell.js';
import { api } from '../api.js';
import { fmtCredits, fmtDate } from '../i18n.js';

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const $ = (id) => document.getElementById(id);
  let page = 1;
  let pages = 1;

  async function load() {
    const res = await api(`/api/history?page=${page}`);
    pages = res.pages;
    const body = $('history-body');
    body.textContent = '';
    $('history-empty').hidden = res.total > 0;
    for (const r of res.items) {
      body.append(
        el('tr', {}, [
          el('td', { cls: 'muted', text: fmtDate(r.created_at) }),
          el('td', { dataT: `game_${r.game}` }),
          el('td', { cls: 'num', text: fmtCredits(r.bet) }),
          el('td', { cls: 'num', text: fmtCredits(r.payout) }),
          el('td', {
            cls: `num ${r.net >= 0 ? 'win-text' : 'lose-text'}`,
            text: (r.net >= 0 ? '+' : '') + fmtCredits(r.net),
          }),
          el('td', { cls: 'num muted', text: String(r.nonce) }),
          el('td', {}, [
            el('a', { dataT: 'hist_verify', attrs: { href: `/verify?round=${r.id}` } }),
          ]),
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
