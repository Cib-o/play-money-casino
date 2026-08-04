import path from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT } from '../config.js';

// Clean URLs for the static pages, with server-side redirects so an
// anonymous visitor lands on /login and a player never sees /admin.
// The real authorisation lives on the API routes — these redirects are
// navigation comfort, not the security boundary.
export function registerPageRoutes(app) {
  const publicDir = path.join(ROOT, 'public');
  const has = (file) => existsSync(path.join(publicDir, file));

  const playerPages = {
    '/': 'index.html',
    '/slots': 'slots.html',
    '/roulette': 'roulette.html',
    '/dice': 'dice.html',
    '/blackjack': 'blackjack.html',
    '/history': 'history.html',
    '/fairness': 'fairness.html',
    '/profile': 'profile.html',
  };
  for (const [route, file] of Object.entries(playerPages)) {
    app.get(route, (req, reply) => {
      if (!app.sessionUser(req)) return reply.redirect('/login');
      if (!has(file)) return reply.code(404).send({ error: 'err_not_found' });
      return reply.sendFile(file);
    });
  }

  // The verifier is deliberately public: anyone holding a revealed
  // seed must be able to check a round without an account.
  if (has('verify.html')) {
    app.get('/verify', (req, reply) => reply.sendFile('verify.html'));
  }

  if (has('login.html')) {
    app.get('/login', (req, reply) => {
      const user = app.sessionUser(req);
      if (user) return reply.redirect(user.role === 'admin' ? '/admin' : '/');
      return reply.sendFile('login.html');
    });
  }

  const adminPages = {
    '/admin': 'admin/index.html',
    '/admin/analytics': 'admin/analytics.html',
    '/admin/audit': 'admin/audit.html',
    '/admin/settings': 'admin/settings.html',
  };
  for (const [route, file] of Object.entries(adminPages)) {
    app.get(route, (req, reply) => {
      const user = app.sessionUser(req);
      if (!user) return reply.redirect('/login');
      if (user.role !== 'admin') return reply.redirect('/');
      if (!has(file)) return reply.code(404).send({ error: 'err_not_found' });
      return reply.sendFile(file);
    });
  }
}
