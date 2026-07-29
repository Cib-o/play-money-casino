import { verifyPassword, decoyVerify, hashPassword } from '../auth.js';
import { readSettings } from '../db.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 10;

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    balance: u.balance,
    locale: u.locale,
  };
}

export function registerAuthRoutes(app) {
  const { db } = app;

  // Login rate limit: 10 attempts per IP per 15-minute window, held in
  // memory. Lazy pruning keeps the map bounded without a timer.
  const attempts = new Map();
  function limited(ip) {
    const now = Date.now();
    if (attempts.size > 5000) {
      for (const [key, entry] of attempts) {
        if (now - entry.start > LOGIN_WINDOW_MS) attempts.delete(key);
      }
    }
    const entry = attempts.get(ip);
    if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
      attempts.set(ip, { start: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > LOGIN_LIMIT;
  }

  const selectByUsername = db.prepare('SELECT * FROM users WHERE username = ?');

  app.post(
    '/api/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (limited(req.ip)) return reply.code(429).send({ error: 'err_rate_limited' });
      const user = selectByUsername.get(req.body.username.trim().toLowerCase());
      // Same error code and same scrypt cost whether or not the
      // username exists — a failed login reveals nothing.
      if (!user) {
        decoyVerify(req.body.password);
        return reply.code(401).send({ error: 'err_bad_credentials' });
      }
      if (!verifyPassword(req.body.password, user.password_hash)) {
        return reply.code(401).send({ error: 'err_bad_credentials' });
      }
      if (!user.is_active) return reply.code(403).send({ error: 'err_account_disabled' });
      app.setSessionCookie(reply, user.id);
      return { user: publicUser(user) };
    },
  );

  app.post('/api/logout', async (req, reply) => {
    app.clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: app.requireUser }, async (req) => ({
    user: publicUser(req.user),
  }));

  // Unauthenticated: the login page needs the platform name and the
  // lobby needs bet limits; none of this is sensitive — the RTP is
  // published on purpose as part of the fairness story.
  app.get('/api/public', async () => {
    const s = readSettings(db);
    return {
      site_name: s.siteName,
      min_bet: s.minBet,
      max_bet: s.maxBet,
      rtp: s.rtp,
      default_locale: s.defaultLocale,
      games: s.games,
    };
  });

  const updateProfile = db.prepare('UPDATE users SET display_name = ?, locale = ? WHERE id = ?');
  app.post(
    '/api/profile',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            display_name: { type: 'string', maxLength: 40 },
            locale: { type: 'string', enum: ['ka', 'en'] },
          },
        },
      },
    },
    async (req) => {
      const display =
        req.body.display_name !== undefined ? req.body.display_name.trim() : req.user.display_name;
      const locale = req.body.locale || req.user.locale;
      updateProfile.run(display, locale, req.user.id);
      return { user: { ...publicUser(req.user), display_name: display, locale } };
    },
  );

  const selectHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
  const updateHash = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  app.post(
    '/api/password',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['current', 'next'],
          properties: {
            current: { type: 'string', minLength: 1, maxLength: 200 },
            next: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const row = selectHash.get(req.user.id);
      if (!verifyPassword(req.body.current, row.password_hash)) {
        return reply.code(400).send({ error: 'err_wrong_password' });
      }
      updateHash.run(hashPassword(req.body.next), req.user.id);
      return { ok: true };
    },
  );
}
