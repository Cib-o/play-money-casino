import { randomUUID } from 'node:crypto';
import { readSettings, nowISO } from '../db.js';
import { AppError } from '../errors.js';
import { getOrCreateSeed, setClientSeed, rotateSeed } from '../seeds.js';
import * as slots from '../games/slots.js';

const PAGE_SIZE = 20;

export function registerGameRoutes(app) {
  const { db } = app;
  const auth = { preHandler: app.requireUser };

  // ── commit-reveal seed endpoints ──────────────────────────────────
  const seedView = (seed) => ({
    server_seed_hash: seed.hash,
    client_seed: seed.client_seed,
    nonce: seed.nonce,
  });

  app.get('/api/seed', auth, async (req) => seedView(getOrCreateSeed(db, req.user.id)));

  app.post(
    '/api/seed/client',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['client_seed'],
          properties: { client_seed: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
        },
      },
    },
    async (req) => {
      setClientSeed(db, req.user.id, req.body.client_seed);
      return seedView(getOrCreateSeed(db, req.user.id));
    },
  );

  app.post('/api/seed/rotate', auth, async (req) => {
    const result = rotateSeed(db, req.user.id);
    return {
      revealed_server_seed: result.revealedServerSeed,
      revealed_hash: result.revealedHash,
      server_seed_hash: result.newHash,
      client_seed: result.clientSeed,
      nonce: 0,
    };
  });

  // ── shared round settlement ───────────────────────────────────────
  const stmts = {
    balance: db.prepare('SELECT balance FROM users WHERE id = ?'),
    updateBalance: db.prepare('UPDATE users SET balance = ? WHERE id = ?'),
    insertRound: db.prepare(
      `INSERT INTO rounds (id, user_id, game, bet, payout, net, outcome_json,
                           server_seed_hash, server_seed, client_seed, nonce, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ),
    bumpNonce: db.prepare('UPDATE seeds SET nonce = nonce + 1 WHERE user_id = ?'),
  };

  // A round settles atomically: balance check, debit+credit, round
  // insert and nonce bump commit together or roll back together, so a
  // crash can never debit a player without recording what they got.
  const resolveRound = db.transaction((userId, game, bet, compute) => {
    const seed = getOrCreateSeed(db, userId);
    const { payout, outcome } = compute(seed);
    const row = stmts.balance.get(userId);
    if (row.balance < bet) throw new AppError(400, 'err_insufficient_balance');
    const balance = row.balance - bet + payout;
    stmts.updateBalance.run(balance, userId);
    const round = {
      id: randomUUID(),
      game,
      bet,
      payout,
      net: payout - bet,
      outcome,
      server_seed_hash: seed.hash,
      client_seed: seed.client_seed,
      nonce: seed.nonce,
      created_at: nowISO(),
    };
    stmts.insertRound.run(
      round.id, userId, game, bet, payout, round.net, JSON.stringify(outcome),
      seed.hash, seed.client_seed, seed.nonce, round.created_at,
    );
    stmts.bumpNonce.run(userId);
    return { balance, round };
  });

  function requireEnabled(settings, game) {
    if (!settings.games[game]) throw new AppError(403, 'err_game_disabled');
  }
  function checkBet(bet, settings) {
    if (bet < settings.minBet) throw new AppError(400, 'err_bet_too_small');
    if (bet > settings.maxBet) throw new AppError(400, 'err_bet_too_large');
  }

  const BET_BODY = {
    type: 'object',
    additionalProperties: false,
    required: ['bet'],
    properties: { bet: { type: 'integer', minimum: 1, maximum: 1000000000 } },
  };

  // ── slots ─────────────────────────────────────────────────────────
  app.post(
    '/api/game/slots/spin',
    { preHandler: app.requireUser, schema: { body: BET_BODY } },
    async (req) => {
      const settings = readSettings(db);
      requireEnabled(settings, 'slots');
      checkBet(req.body.bet, settings);
      return resolveRound(req.user.id, 'slots', req.body.bet, (seed) => {
        const out = slots.spin({
          serverSeed: seed.server_seed,
          clientSeed: seed.client_seed,
          nonce: seed.nonce,
          rtp: settings.rtp,
          bet: req.body.bet,
        });
        return { payout: out.payout, outcome: { rtp: settings.rtp, mult: out.mult, reels: out.reels } };
      });
    },
  );

  // ── history ───────────────────────────────────────────────────────
  const roundView = (r) => ({
    id: r.id,
    game: r.game,
    bet: r.bet,
    payout: r.payout,
    net: r.net,
    outcome: JSON.parse(r.outcome_json),
    server_seed_hash: r.server_seed_hash,
    server_seed: r.server_seed,
    client_seed: r.client_seed,
    nonce: r.nonce,
    created_at: r.created_at,
  });

  app.get(
    '/api/history',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { page: { type: 'integer', minimum: 1, default: 1 } },
        },
      },
    },
    async (req) => {
      const total = db
        .prepare('SELECT COUNT(*) AS c FROM rounds WHERE user_id = ?')
        .get(req.user.id).c;
      const items = db
        .prepare(
          `SELECT * FROM rounds WHERE user_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(req.user.id, PAGE_SIZE, (req.query.page - 1) * PAGE_SIZE)
        .map(roundView);
      return { items, page: req.query.page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
    },
  );

  app.get(
    '/api/rounds/:id',
    {
      preHandler: app.requireUser,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (req) => {
      const r = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
      if (!r || (r.user_id !== req.user.id && req.user.role !== 'admin')) {
        throw new AppError(404, 'err_not_found');
      }
      return { round: roundView(r) };
    },
  );
}
