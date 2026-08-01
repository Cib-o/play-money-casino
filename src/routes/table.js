import { readSettings } from '../db.js';
import { AppError } from '../errors.js';

// HTTP surface for the shared server-side blackjack table. The table
// itself runs on timers in blackjack-table.js; these routes just read
// a snapshot and forward a seat's intents. Clients poll the snapshot
// on an interval, so no websocket dependency is needed.
export function registerTableRoutes(app, table) {
  const { db } = app;
  const auth = { preHandler: app.requireUser };

  app.get('/api/game/blackjack/table', auth, async (req) => table.snapshot(req.user));

  app.post(
    '/api/game/blackjack/sit',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['seat'],
          properties: { seat: { type: 'integer', minimum: 0, maximum: 6 } },
        },
      },
    },
    async (req) => {
      if (!readSettings(db).games.blackjack) throw new AppError(403, 'err_game_disabled');
      return table.sit(req.user, req.body.seat);
    },
  );

  app.post(
    '/api/game/blackjack/bet',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amount'],
          properties: { amount: { type: 'integer', minimum: 0, maximum: 1000000000 } },
        },
      },
    },
    async (req) => table.bet(req.user, req.body.amount),
  );

  app.post('/api/game/blackjack/leave', auth, async (req) => table.leave(req.user));

  app.post(
    '/api/game/blackjack/move',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['move'],
          properties: { move: { type: 'string', enum: ['hit', 'stand', 'double'] } },
        },
      },
    },
    async (req) => table.action(req.user, req.body.move),
  );
}
