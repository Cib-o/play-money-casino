import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { ROOT } from './config.js';
import { createSessionToken, verifySessionToken, SESSION_TTL_SECONDS } from './auth.js';
import { AppError } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerGameRoutes } from './routes/game.js';
import { registerBlackjackRoutes } from './routes/blackjack.js';
import { registerTableRoutes } from './routes/table.js';
import { createBlackjackTable } from './blackjack-table.js';
import { registerPageRoutes } from './routes/pages.js';

const SESSION_COOKIE = 'sid';

/**
 * Build the Fastify app around an injected database handle, so tests
 * can run the full HTTP surface against an in-memory SQLite.
 */
export function buildApp({ db, config, logger = false }) {
  const app = Fastify({
    logger,
    trustProxy: true,
    // additionalProperties:false must REJECT unknown fields, not
    // silently strip them (ajv's default removeAdditional would), and
    // coerceTypes must stay scalar: the default 'array' mode mutates
    // oneOf branches (turning a straight-bet selection 17 into [17])
    // even when another branch already matched.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true } },
  });

  app.register(fastifyCookie);
  app.register(fastifyFormbody);

  const publicDir = path.join(ROOT, 'public');
  const hasPublic = existsSync(publicDir);
  if (hasPublic) app.register(fastifyStatic, { root: publicDir, index: false });

  app.decorate('db', db);
  app.decorate('appConfig', config);
  app.decorateRequest('user', null);

  // Baseline security headers. The frontend contains no inline scripts
  // or styles, so the CSP can stay strict.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; " +
        "style-src 'self' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; " +
        "form-action 'self'",
    );
  });

  const selectUser = db.prepare(
    'SELECT id, username, display_name, role, balance, locale, is_active FROM users WHERE id = ?',
  );

  // Sessions are re-checked against the users table on every request,
  // so disabling an account revokes its sessions immediately.
  app.decorate('sessionUser', (req) => {
    const token = req.cookies ? req.cookies[SESSION_COOKIE] : undefined;
    if (!token) return null;
    const userId = verifySessionToken(token, config.sessionSecret);
    if (!userId) return null;
    const user = selectUser.get(userId);
    if (!user || !user.is_active) return null;
    return user;
  });

  app.decorate('setSessionCookie', (reply, userId) => {
    reply.setCookie(SESSION_COOKIE, createSessionToken(userId, config.sessionSecret), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.production,
      maxAge: SESSION_TTL_SECONDS,
    });
  });

  app.decorate('clearSessionCookie', (reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  });

  // Guards. requireAdmin runs as a scope-level preHandler on every
  // /api/admin route — before the handler, never inside it.
  app.decorate('requireUser', async (req, reply) => {
    const user = app.sessionUser(req);
    if (!user) return reply.code(401).send({ error: 'err_unauthorized' });
    req.user = user;
  });
  app.decorate('requireAdmin', async (req, reply) => {
    const user = app.sessionUser(req);
    if (!user) return reply.code(401).send({ error: 'err_unauthorized' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'err_forbidden' });
    req.user = user;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code });
    if (err.validation) return reply.code(400).send({ error: 'err_validation' });
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status < 500 ? 'err_validation' : 'err_generic' });
  });

  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith('/api/') && hasPublic) return reply.redirect('/');
    return reply.code(404).send({ error: 'err_not_found' });
  });

  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerGameRoutes(app);
  registerBlackjackRoutes(app);

  // The shared table is created here but its round loop is started
  // explicitly by the server entrypoint (not during tests), and is
  // stopped when the app closes so no timers leak.
  const table = createBlackjackTable(db);
  app.decorate('blackjackTable', table);
  registerTableRoutes(app, table);
  app.addHook('onClose', (instance, done) => {
    table.stop();
    done();
  });

  if (hasPublic) registerPageRoutes(app);

  return app;
}
