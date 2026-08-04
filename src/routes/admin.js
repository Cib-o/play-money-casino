import { randomUUID } from 'node:crypto';
import { readSettings, setSetting, nowISO } from '../db.js';
import { hashPassword, generatePassword } from '../auth.js';
import { AppError } from '../errors.js';

const PAGE_SIZE = 20;

const ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
};

function settingsView(db) {
  const s = readSettings(db);
  return {
    rtp: s.rtp,
    min_bet: s.minBet,
    max_bet: s.maxBet,
    default_balance: s.defaultBalance,
    default_locale: s.defaultLocale,
    site_name: s.siteName,
    blackjack_max_bots: s.maxBots,
    games: s.games,
  };
}

// A realized RTP is a sample mean, and over anything short of a few
// thousand rounds a very noisy one — three lucky spins read as 340%.
// Published bare it invites ordinary variance to be mistaken for a
// broken paytable, so the figure never leaves here without its spread.
//
// The headline is money-weighted, paid out over wagered, which is what
// RTP means. Its standard error is the per-round return's deviation
// scaled by sqrt(Σbet²)/Σbet — the standard error of a weighted mean,
// which collapses to sd/sqrt(n) when every stake is the same size.
function withReturn(row) {
  const totals = {
    rounds: row.rounds,
    wagered: row.wagered,
    paid_out: row.paid_out,
    net: row.net,
    won: row.won,
    lost: row.lost,
    rtp: null,
    rtp_stderr: null,
  };
  if (!row.ratio_n || row.wagered <= 0) return totals;
  totals.rtp = row.paid_out / row.wagered;
  // One round is a point, not a sample; it has no spread to report.
  if (row.ratio_n < 2) return totals;
  const mean = row.ret_sum / row.ratio_n;
  const variance = Math.max(0, (row.ret_sq - row.ratio_n * mean * mean) / (row.ratio_n - 1));
  totals.rtp_stderr = (Math.sqrt(variance) * Math.sqrt(row.bet_sq)) / row.wagered;
  return totals;
}

export function registerAdminRoutes(app) {
  const { db } = app;

  app.register(
    async (admin) => {
      // Role check runs before every handler in this scope.
      admin.addHook('preHandler', app.requireAdmin);

      const insertAdjustment = db.prepare(
        `INSERT INTO balance_adjustments (id, user_id, admin_id, "before", "after", delta, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const selectPlayer = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'player'");
      const updateBalance = db.prepare('UPDATE users SET balance = ? WHERE id = ?');

      // ── players list ────────────────────────────────────────────
      const listPlayers = db.prepare(
        `SELECT u.id, u.username, u.display_name, u.balance, u.locale, u.is_active, u.created_at,
                (SELECT COUNT(*) FROM rounds r WHERE r.user_id = u.id) AS rounds
         FROM users u
         WHERE u.role = 'player' AND u.username LIKE ? ESCAPE '\\'
         ORDER BY u.created_at DESC, u.rowid DESC`,
      );
      admin.get(
        '/players',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: { search: { type: 'string', maxLength: 64, default: '' } },
            },
          },
        },
        async (req) => {
          const escaped = req.query.search.replace(/[\\%_]/g, (m) => `\\${m}`);
          return { items: listPlayers.all(`%${escaped}%`) };
        },
      );

      // ── create player ───────────────────────────────────────────
      const insertUser = db.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
         VALUES (?, ?, ?, ?, 'player', ?, ?, 1, ?, ?)`,
      );
      const createPlayer = db.transaction((body, adminId, defaults, passwordHash) => {
        const id = randomUUID();
        const username = body.username.toLowerCase();
        const balance = body.balance !== undefined ? body.balance : defaults.defaultBalance;
        const locale = body.locale || defaults.defaultLocale;
        const display = (body.display_name || '').trim() || username;
        insertUser.run(id, username, display, passwordHash, balance, locale, nowISO(), adminId);
        // The starting balance is an admin edit like any other: it
        // must leave an audit row.
        if (balance > 0) {
          insertAdjustment.run(randomUUID(), id, adminId, 0, balance, balance, 'starting balance', nowISO());
        }
        return { id, username, display_name: display, balance, locale, is_active: 1 };
      });

      admin.post(
        '/players',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['username'],
              properties: {
                username: { type: 'string', pattern: '^[A-Za-z0-9_.-]{3,32}$' },
                display_name: { type: 'string', maxLength: 40 },
                balance: { type: 'integer', minimum: 0, maximum: 1000000000 },
                locale: { type: 'string', enum: ['ka', 'en'] },
                password: { type: 'string', minLength: 8, maxLength: 200 },
              },
            },
          },
        },
        async (req, reply) => {
          // admin may set a password, otherwise a readable one is generated
          const password = req.body.password && req.body.password.length >= 8
            ? req.body.password
            : generatePassword();
          const passwordHash = hashPassword(password);
          try {
            const user = createPlayer(req.body, req.user.id, readSettings(db), passwordHash);
            return reply.code(201).send({ user, password });
          } catch (err) {
            if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
              throw new AppError(409, 'err_username_taken');
            }
            throw err;
          }
        },
      );

      // ── edit balance ────────────────────────────────────────────
      const adjustBalance = db.transaction((playerId, adminId, body) => {
        const player = selectPlayer.get(playerId);
        if (!player) throw new AppError(404, 'err_not_found');
        const before = player.balance;
        const after = body.set !== undefined ? body.set : before + body.delta;
        if (!Number.isInteger(after) || after > 1e12) throw new AppError(400, 'err_validation');
        if (after < 0) throw new AppError(400, 'err_negative_balance');
        updateBalance.run(after, playerId);
        const adjustment = {
          id: randomUUID(),
          user_id: playerId,
          admin_id: adminId,
          before,
          after,
          delta: after - before,
          note: (body.note || '').trim(),
          created_at: nowISO(),
        };
        insertAdjustment.run(
          adjustment.id, playerId, adminId, before, after, adjustment.delta,
          adjustment.note, adjustment.created_at,
        );
        return { balance: after, adjustment };
      });

      admin.post(
        '/players/:id/balance',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                set: { type: 'integer', minimum: 0, maximum: 1000000000000 },
                delta: { type: 'integer', minimum: -1000000000000, maximum: 1000000000000 },
                note: { type: 'string', maxLength: 200 },
              },
            },
          },
        },
        async (req) => {
          const hasSet = req.body.set !== undefined;
          const hasDelta = req.body.delta !== undefined;
          // Exactly one of the two inputs may apply — never both.
          if (hasSet === hasDelta) throw new AppError(400, 'err_validation');
          return adjustBalance(req.params.id, req.user.id, req.body);
        },
      );

      const recentAdjustments = db.prepare(
        `SELECT a.*, ad.username AS admin_username
         FROM balance_adjustments a JOIN users ad ON ad.id = a.admin_id
         WHERE a.user_id = ?
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT 10`,
      );
      admin.get('/players/:id/adjustments', { schema: { params: ID_PARAMS } }, async (req) => {
        if (!selectPlayer.get(req.params.id)) throw new AppError(404, 'err_not_found');
        return { items: recentAdjustments.all(req.params.id) };
      });

      // ── reset password / enable-disable ─────────────────────────
      const updateHash = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
      admin.post('/players/:id/reset-password', { schema: { params: ID_PARAMS } }, async (req) => {
        const player = selectPlayer.get(req.params.id);
        if (!player) throw new AppError(404, 'err_not_found');
        const password = generatePassword();
        updateHash.run(hashPassword(password), player.id);
        return { username: player.username, password };
      });

      admin.post(
        '/players/:id/active',
        {
          schema: {
            params: ID_PARAMS,
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['is_active'],
              properties: { is_active: { type: 'boolean' } },
            },
          },
        },
        async (req) => {
          const player = selectPlayer.get(req.params.id);
          if (!player) throw new AppError(404, 'err_not_found');
          db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(
            req.body.is_active ? 1 : 0,
            player.id,
          );
          return { id: player.id, is_active: req.body.is_active };
        },
      );

      // ── delete player ───────────────────────────────────────────
      // Removes the player and everything that references them, in one
      // transaction. Their live table seat is freed first so the round
      // loop never touches a user row that is about to disappear.
      const deletePlayer = db.transaction((id) => {
        db.prepare('DELETE FROM balance_adjustments WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM rounds WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM seeds WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM blackjack_states WHERE user_id = ?').run(id);
        db.prepare("DELETE FROM users WHERE id = ? AND role = 'player'").run(id);
      });
      admin.post('/players/:id/delete', { schema: { params: ID_PARAMS } }, async (req) => {
        const player = selectPlayer.get(req.params.id);
        if (!player) throw new AppError(404, 'err_not_found');
        if (app.blackjackTable) app.blackjackTable.removeUser(player.id);
        deletePlayer(player.id);
        return { id: player.id, deleted: true };
      });

      // ── audit log ───────────────────────────────────────────────
      const PAGE_QS = {
        type: 'object',
        additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1, default: 1 } },
      };
      admin.get('/audit', { schema: { querystring: PAGE_QS } }, async (req) => {
        const total = db.prepare('SELECT COUNT(*) AS c FROM balance_adjustments').get().c;
        const items = db
          .prepare(
            `SELECT a.*, p.username AS player_username, ad.username AS admin_username
             FROM balance_adjustments a
             JOIN users p ON p.id = a.user_id
             JOIN users ad ON ad.id = a.admin_id
             ORDER BY a.created_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
          )
          .all(PAGE_SIZE, (req.query.page - 1) * PAGE_SIZE);
        return { items, page: req.query.page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
      });

      // ── recent rounds (activity review) ─────────────────────────
      admin.get(
        '/rounds',
        {
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                page: { type: 'integer', minimum: 1, default: 1 },
                user_id: { type: 'string', maxLength: 64 },
              },
            },
          },
        },
        async (req) => {
          const where = req.query.user_id ? 'WHERE r.user_id = ?' : '';
          const params = req.query.user_id ? [req.query.user_id] : [];
          const total = db
            .prepare(`SELECT COUNT(*) AS c FROM rounds r ${where}`)
            .get(...params).c;
          const items = db
            .prepare(
              `SELECT r.id, r.game, r.bet, r.payout, r.net, r.nonce, r.created_at, u.username
               FROM rounds r JOIN users u ON u.id = r.user_id ${where}
               ORDER BY r.created_at DESC, r.rowid DESC LIMIT ? OFFSET ?`,
            )
            .all(...params, PAGE_SIZE, (req.query.page - 1) * PAGE_SIZE);
          return { items, page: req.query.page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
        },
      );

      // ── analytics ───────────────────────────────────────────────
      // A shared-table round is written when the cards come out and
      // rewritten when it settles, so between those two moments the row
      // is real but has no outcome yet: payout 0, result null. The stake
      // has genuinely left the player's balance, so those rows count in
      // the money; they stay out of every return figure, where a payout
      // that simply has not happened yet would read as a total loss.
      //
      // `IS 1` and not `= 1`: a slots or dice round has no `table` key at
      // all, so json_extract hands back NULL, and NULL = 1 is itself NULL
      // — which would make the negation NULL too and quietly drop every
      // round that is not blackjack from every figure below. `IS` is the
      // null-safe comparison and answers false, as intended.
      const IN_FLIGHT =
        "json_extract(r.outcome_json, '$.table') IS 1 AND json_extract(r.outcome_json, '$.result') IS NULL";
      const SETTLED = `NOT (${IN_FLIGHT})`;

      // The money, plus the three sums needed to say how firm the return
      // is: how many rounds carried a stake, the squared stakes, and the
      // first two moments of the per-round return ratio.
      const TOTALS = `
        COUNT(*) AS rounds,
        COALESCE(SUM(r.bet), 0) AS wagered,
        COALESCE(SUM(r.payout), 0) AS paid_out,
        COALESCE(SUM(r.net), 0) AS net,
        COALESCE(SUM(CASE WHEN r.net > 0 THEN r.net ELSE 0 END), 0) AS won,
        COALESCE(-SUM(CASE WHEN r.net < 0 THEN r.net ELSE 0 END), 0) AS lost,
        COUNT(CASE WHEN r.bet > 0 THEN 1 END) AS ratio_n,
        COALESCE(SUM(CASE WHEN r.bet > 0 THEN CAST(r.bet AS REAL) * r.bet END), 0) AS bet_sq,
        COALESCE(SUM(CASE WHEN r.bet > 0 THEN CAST(r.payout AS REAL) / r.bet END), 0) AS ret_sum,
        COALESCE(SUM(CASE WHEN r.bet > 0
                     THEN (CAST(r.payout AS REAL) / r.bet) * (CAST(r.payout AS REAL) / r.bet) END), 0) AS ret_sq`;

      const grantsFor = (where) => `
        SELECT COUNT(*) AS adjustments,
               COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS granted,
               COALESCE(-SUM(CASE WHEN delta < 0 THEN delta ELSE 0 END), 0) AS removed
        FROM balance_adjustments ${where}`;
      const inFlightFor = (where) => `
        SELECT COUNT(*) AS rounds, COALESCE(-SUM(r.net), 0) AS staked
        FROM rounds r WHERE ${where} ${IN_FLIGHT}`;

      const q = {
        floorTotals: db.prepare(`SELECT ${TOTALS} FROM rounds r WHERE ${SETTLED}`),
        floorByGame: db.prepare(
          `SELECT r.game, ${TOTALS} FROM rounds r WHERE ${SETTLED} GROUP BY r.game ORDER BY r.game`,
        ),
        floorInFlight: db.prepare(inFlightFor('')),
        floorGrants: db.prepare(grantsFor('')),
        // Every credit that exists, not just the players' — an admin is
        // created with nothing and no endpoint can grant them any, but
        // counting the whole table means the check below cannot be
        // satisfied by a balance it forgot to look at.
        floorCredits: db.prepare(
          `SELECT COALESCE(SUM(balance), 0) AS balance, COUNT(*) AS users,
                  COALESCE(SUM(CASE WHEN role = 'player' THEN 1 ELSE 0 END), 0) AS players
           FROM users`,
        ),
        playerTotals: db.prepare(`SELECT ${TOTALS} FROM rounds r WHERE r.user_id = ? AND ${SETTLED}`),
        playerByGame: db.prepare(
          `SELECT r.game, ${TOTALS} FROM rounds r WHERE r.user_id = ? AND ${SETTLED}
           GROUP BY r.game ORDER BY r.game`,
        ),
        playerInFlight: db.prepare(inFlightFor('r.user_id = ? AND')),
        playerGrants: db.prepare(grantsFor('WHERE user_id = ?')),
        // Best round by net, not by payout: 400 back on a 500 stake is
        // the shape of a loss however large the payout column reads. A
        // player who never came out ahead gets their smallest loss here,
        // which is the true answer and shows as a negative number.
        playerBest: db.prepare(
          `SELECT r.game, r.bet, r.payout, r.net, r.created_at FROM rounds r
           WHERE r.user_id = ? AND ${SETTLED} ORDER BY r.net DESC, r.rowid ASC LIMIT 1`,
        ),
        playerSpan: db.prepare(
          'SELECT MIN(created_at) AS first_round, MAX(created_at) AS last_round FROM rounds WHERE user_id = ?',
        ),
      };

      // Credits are granted by an admin and after that only move by
      // being staked; nothing mints them and nothing burns them. So the
      // balances on hand must equal what was granted, less what was
      // taken back, plus what play has returned, less what is sitting in
      // hands still being played. If that ever fails to close, something
      // wrote to a balance without leaving a record, and the dashboard
      // says so instead of showing a total it cannot account for.
      function reconcile(balance, grants, settled, inFlight) {
        const expected = grants.granted - grants.removed + settled.net - inFlight.staked;
        return { drift: balance - expected, reconciled: balance === expected };
      }

      admin.get('/circulation', async () => {
        const credits = q.floorCredits.get();
        const grants = q.floorGrants.get();
        const settled = withReturn(q.floorTotals.get());
        const in_flight = q.floorInFlight.get();
        return {
          balance: credits.balance,
          users: credits.users,
          players: credits.players,
          ...grants,
          in_flight,
          ...reconcile(credits.balance, grants, settled, in_flight),
          ...settled,
          games: q.floorByGame.all().map((g) => ({ game: g.game, ...withReturn(g) })),
        };
      });

      admin.get('/players/:id/analytics', { schema: { params: ID_PARAMS } }, async (req) => {
        const player = selectPlayer.get(req.params.id);
        if (!player) throw new AppError(404, 'err_not_found');
        const grants = q.playerGrants.get(player.id);
        const settled = withReturn(q.playerTotals.get(player.id));
        const in_flight = q.playerInFlight.get(player.id);
        const span = q.playerSpan.get(player.id);
        return {
          player: {
            id: player.id,
            username: player.username,
            display_name: player.display_name,
            balance: player.balance,
            is_active: player.is_active,
            created_at: player.created_at,
          },
          ...grants,
          in_flight,
          ...reconcile(player.balance, grants, settled, in_flight),
          best_round: q.playerBest.get(player.id) || null,
          first_round: span.first_round,
          last_round: span.last_round,
          ...settled,
          games: q.playerByGame.all(player.id).map((g) => ({ game: g.game, ...withReturn(g) })),
        };
      });

      // ── settings ────────────────────────────────────────────────
      admin.get('/settings', async () => settingsView(db));

      admin.post(
        '/settings',
        {
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rtp: { type: 'number', minimum: 0.8, maximum: 0.99 },
                // In hundredths, so a minimum of 1 is the 0.01 floor and
                // the ceilings are the same real amounts they were
                // before the unit changed.
                min_bet: { type: 'integer', minimum: 1, maximum: 100000000 },
                max_bet: { type: 'integer', minimum: 1, maximum: 10000000000 },
                default_balance: { type: 'integer', minimum: 0, maximum: 1000000000000 },
                default_locale: { type: 'string', enum: ['ka', 'en'] },
                site_name: { type: 'string', minLength: 1, maxLength: 40 },
                blackjack_max_bots: { type: 'integer', minimum: 0, maximum: 6 },
                games: { type: 'object', additionalProperties: { type: 'boolean' } },
              },
            },
          },
        },
        async (req) => {
          const current = readSettings(db);
          const minBet = req.body.min_bet !== undefined ? req.body.min_bet : current.minBet;
          const maxBet = req.body.max_bet !== undefined ? req.body.max_bet : current.maxBet;
          if (maxBet < minBet) throw new AppError(400, 'err_validation');
          if (req.body.games) {
            for (const key of Object.keys(req.body.games)) {
              if (!(key in current.games)) throw new AppError(400, 'err_validation');
            }
          }
          if (req.body.rtp !== undefined) setSetting(db, 'rtp', String(req.body.rtp));
          if (req.body.min_bet !== undefined) setSetting(db, 'min_bet', String(req.body.min_bet));
          if (req.body.max_bet !== undefined) setSetting(db, 'max_bet', String(req.body.max_bet));
          if (req.body.default_balance !== undefined) {
            setSetting(db, 'default_balance', String(req.body.default_balance));
          }
          if (req.body.default_locale !== undefined) {
            setSetting(db, 'default_locale', req.body.default_locale);
          }
          if (req.body.site_name !== undefined) {
            setSetting(db, 'site_name', req.body.site_name.trim());
          }
          if (req.body.blackjack_max_bots !== undefined) {
            setSetting(db, 'blackjack_max_bots', String(req.body.blackjack_max_bots));
          }
          if (req.body.games) {
            for (const [key, on] of Object.entries(req.body.games)) {
              setSetting(db, `game_${key}`, on ? '1' : '0');
            }
          }
          return settingsView(db);
        },
      );
    },
    { prefix: '/api/admin' },
  );
}
