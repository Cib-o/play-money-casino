import { randomUUID } from 'node:crypto';
import { readSettings, nowISO } from '../db.js';
import { AppError } from '../errors.js';
import { getOrCreateSeed, setClientSeed, rotateSeed } from '../seeds.js';
import * as slots from '../games/slots.js';
import * as roulette from '../games/roulette.js';
import * as dice from '../games/dice.js';

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
    // Rotating reveals the server seed; while a blackjack round is
    // open that seed determines the dealer's next cards, so the
    // reveal must wait until the hand is finished.
    const openRound = db
      .prepare('SELECT user_id FROM blackjack_states WHERE user_id = ?')
      .get(req.user.id);
    if (openRound) throw new AppError(400, 'err_round_in_progress');
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

  // ── slots ─────────────────────────────────────────────────────────
  // Every machine on the floor runs the same calibration at the same
  // RTP; the machine id only selects which paytable and reel count the
  // draw is resolved against. The list is served from the registry so
  // the odds a player reads are the odds the server plays.
  app.get('/api/game/slots/machines', auth, async () => {
    const settings = readSettings(db);
    requireEnabled(settings, 'slots');
    return {
      rtp: settings.rtp,
      default: slots.DEFAULT_MACHINE,
      machines: slots.MACHINE_IDS.map((id) => slots.machineView(id, settings.rtp)),
    };
  });

  app.post(
    '/api/game/slots/spin',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['bet'],
          properties: {
            bet: { type: 'integer', minimum: 1, maximum: 1000000000 },
            machine: { type: 'string', enum: slots.MACHINE_IDS },
          },
        },
      },
    },
    async (req) => {
      const settings = readSettings(db);
      requireEnabled(settings, 'slots');
      checkBet(req.body.bet, settings);
      const machine = req.body.machine || slots.DEFAULT_MACHINE;
      return resolveRound(req.user.id, 'slots', req.body.bet, (seed) => {
        const out = slots.spin({
          serverSeed: seed.server_seed,
          clientSeed: seed.client_seed,
          nonce: seed.nonce,
          rtp: settings.rtp,
          bet: req.body.bet,
          machine,
        });
        return {
          payout: out.payout,
          outcome: { rtp: settings.rtp, machine: out.machine, mult: out.mult, reels: out.reels },
        };
      });
    },
  );

  // ── roulette ──────────────────────────────────────────────────────
  const ROULETTE_BET = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'amount'],
    properties: {
      type: {
        type: 'string',
        enum: ['straight', 'split', 'red', 'black', 'odd', 'even', 'dozen', 'column'],
      },
      amount: { type: 'integer', minimum: 1, maximum: 1000000000 },
      selection: {
        oneOf: [
          { type: 'integer', minimum: 0, maximum: 36 },
          {
            type: 'array',
            items: { type: 'integer', minimum: 0, maximum: 36 },
            minItems: 2,
            maxItems: 2,
          },
        ],
      },
    },
  };

  app.post(
    '/api/game/roulette/spin',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['bets'],
          properties: {
            bets: { type: 'array', minItems: 1, maxItems: 30, items: ROULETTE_BET },
          },
        },
      },
    },
    async (req) => {
      const settings = readSettings(db);
      requireEnabled(settings, 'roulette');
      for (const bet of req.body.bets) {
        if (!roulette.validateBet(bet)) throw new AppError(400, 'err_validation');
      }
      // The min/max limits apply to the round's total stake; each
      // individual bet already has a schema minimum of 1.
      const total = req.body.bets.reduce((sum, bet) => sum + bet.amount, 0);
      checkBet(total, settings);
      return resolveRound(req.user.id, 'roulette', total, (seed) => {
        const number = roulette.spinNumber({
          serverSeed: seed.server_seed,
          clientSeed: seed.client_seed,
          nonce: seed.nonce,
        });
        const { payout, results } = roulette.settle(req.body.bets, number);
        return { payout, outcome: { number, bets: results } };
      });
    },
  );

  // ── dice ──────────────────────────────────────────────────────────
  app.post(
    '/api/game/dice/roll',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['bet', 'target', 'direction'],
          properties: {
            bet: { type: 'integer', minimum: 1, maximum: 1000000000 },
            target: { type: 'integer', minimum: dice.MIN_TARGET, maximum: dice.MAX_TARGET },
            direction: { type: 'string', enum: ['under', 'over'] },
          },
        },
      },
    },
    async (req) => {
      const settings = readSettings(db);
      requireEnabled(settings, 'dice');
      checkBet(req.body.bet, settings);
      return resolveRound(req.user.id, 'dice', req.body.bet, (seed) => {
        const out = dice.roll({
          serverSeed: seed.server_seed,
          clientSeed: seed.client_seed,
          nonce: seed.nonce,
          rtp: settings.rtp,
          bet: req.body.bet,
          target: req.body.target,
          direction: req.body.direction,
        });
        return {
          payout: out.payout,
          outcome: {
            rtp: settings.rtp,
            target: req.body.target,
            direction: req.body.direction,
            roll: out.r,
            win: out.win,
            mult: out.mult,
          },
        };
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
