import { initShell, state, el } from '../shell.js';

// One entry per shipped game; the lobby shows the intersection of
// this list and the games the server reports as enabled.
const GAME_META = [
  { key: 'slots', href: '/slots', art: '🎰', hint: 'hint_slots' },
  { key: 'roulette', href: '/roulette', art: '🎡', hint: 'hint_roulette' },
  { key: 'dice', href: '/dice', art: '🎲', hint: 'hint_dice' },
];

const ctx = await initShell({ requireAuth: true });

if (ctx) {
  const tiles = document.getElementById('tiles');
  for (const meta of GAME_META) {
    if (!state.pub || !state.pub.games[meta.key]) continue;
    tiles.append(
      el('a', { cls: 'game-tile', attrs: { href: meta.href } }, [
        el('div', { cls: 'art', text: meta.art }),
        el('div', { cls: 'name', dataT: `game_${meta.key}` }),
        el('div', { cls: 'hint', dataT: meta.hint }),
        el('div', { cls: 'glow' }),
      ]),
    );
  }
}
