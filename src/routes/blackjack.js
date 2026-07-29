import { randomUUID } from 'node:crypto';
import { readSettings, nowISO } from '../db.js';
import { AppError } from '../errors.js';
import { getOrCreateSeed } from '../seeds.js';
import * as bj from '../games/blackjack.js';

// Blackjack spans several requests, so an open round lives in
// blackjack_states with the bet already debited — a crash never
// leaves a player silently charged: the state (and the money's
// whereabouts) survive restarts and the round resumes. The seed
// material is snapshotted into the state at deal time; rotation is
// blocked while a round is open (see game.js), because revealing the
// server seed mid-hand would expose the dealer's next cards.

export function registerBlackjackRoutes(app) {
  const { db } = app;

  const stmts = {
    getState: db.prepare('SELECT state_json FROM blackjack_states WHERE user_id = ?'),
    putState: db.prepare(
      `INSERT INTO blackjack_states (user_id, state_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    ),
    delState: db.prepare('DELETE FROM blackjack_states WHERE user_id = ?'),
    balance: db.prepare('SELECT balance FROM users WHERE id = ?'),
    updBalance: db.prepare('UPDATE users SET balance = ? WHERE id = ?'),
    insRound: db.prepare(
      `INSERT INTO rounds (id, user_id, game, bet, payout, net, outcome_json,
                           server_seed_hash, server_seed, client_seed, nonce, created_at)
       VALUES (?, ?, 'blackjack', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ),
    bumpNonce: db.prepare('UPDATE seeds SET nonce = nonce + 1 WHERE user_id = ?'),
  };

  const loadState = (userId) => {
    const row = stmts.getState.get(userId);
    return row ? JSON.parse(row.state_json) : null;
  };
  const draw = (state) =>
    bj.makeDraw({ serverSeed: state.serverSeed, clientSeed: state.clientSeed, nonce: state.nonce });

  // What the client is allowed to see mid-round: the hole card stays
  // on the server until the round resolves.
  function publicState(state) {
    return {
      bet: state.bet,
      doubled: state.doubled,
      player: state.player,
      player_total: bj.handTotal(state.player),
      dealer_up: state.dealer[0],
      actions: state.actions,
      can_double: state.player.length === 2 && !state.doubled,
    };
  }

  function roundView(userId, state, settleResult) {
    return {
      id: randomUUID(),
      stake: state.doubled ? state.bet * 2 : state.bet,
      outcome: {
        player: state.player,
        dealer: state.dealer,
        actions: state.actions,
        doubled: state.doubled,
        result: settleResult.result,
        player_total: bj.handTotal(state.player).total,
        dealer_total: bj.handTotal(state.dealer).total,
      },
    };
  }

  // Finish an open round: credit the payout, record the round, drop
  // the state — one transaction. resolveInline carries the body so
  // deal/double can run the same steps inside their own transaction
  // (better-sqlite3 nests via savepoints).
  function resolveInline(userId, state) {
    const settled = bj.settleOutcome(state.player, state.dealer, state);
    const view = roundView(userId, state, settled);
    const row = stmts.balance.get(userId);
    const balance = row.balance + settled.payout;
    stmts.updBalance.run(balance, userId);
    stmts.insRound.run(
      view.id, userId, view.stake, settled.payout, settled.payout - view.stake,
      JSON.stringify(view.outcome), state.serverSeedHash, state.clientSeed,
      state.nonce, nowISO(),
    );
    stmts.delState.run(userId);
    return {
      balance,
      round: {
        id: view.id,
        game: 'blackjack',
        bet: view.stake,
        payout: settled.payout,
        net: settled.payout - view.stake,
        outcome: view.outcome,
        nonce: state.nonce,
        server_seed_hash: state.serverSeedHash,
      },
    };
  }
  const resolveTxn = db.transaction(resolveInline);

  const auth = { preHandler: app.requireUser };

  app.get('/api/game/blackjack/state', auth, async (req) => {
    const state = loadState(req.user.id);
    return { state: state ? publicState(state) : null };
  });

  const dealTxn = db.transaction((userId, bet) => {
    const row = stmts.balance.get(userId);
    if (row.balance < bet) throw new AppError(400, 'err_insufficient_balance');
    stmts.updBalance.run(row.balance - bet, userId);
    const seed = getOrCreateSeed(db, userId);
    const state = {
      bet,
      doubled: false,
      serverSeed: seed.server_seed,
      serverSeedHash: seed.hash,
      clientSeed: seed.client_seed,
      nonce: seed.nonce,
      cursor: 4,
      actions: [],
      player: [],
      dealer: [],
    };
    const d = draw(state);
    state.player = [d(0), d(2)];
    state.dealer = [d(1), d(3)];
    stmts.bumpNonce.run(userId);
    // A natural on either side resolves immediately.
    if (bj.isBlackjack(state.player) || bj.isBlackjack(state.dealer)) {
      return { immediate: true, ...resolveInline(userId, state) };
    }
    stmts.putState.run(userId, JSON.stringify(state), nowISO());
    return { immediate: false, balance: row.balance - bet, state };
  });

  app.post(
    '/api/game/blackjack/deal',
    {
      preHandler: app.requireUser,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['bet'],
          properties: { bet: { type: 'integer', minimum: 1, maximum: 1000000000 } },
        },
      },
    },
    async (req) => {
      const settings = readSettings(db);
      if (!settings.games.blackjack) throw new AppError(403, 'err_game_disabled');
      if (req.body.bet < settings.minBet) throw new AppError(400, 'err_bet_too_small');
      if (req.body.bet > settings.maxBet) throw new AppError(400, 'err_bet_too_large');
      if (loadState(req.user.id)) throw new AppError(400, 'err_round_in_progress');
      const out = dealTxn(req.user.id, req.body.bet);
      if (out.immediate) return { balance: out.balance, round: out.round };
      return { balance: out.balance, state: publicState(out.state) };
    },
  );

  function requireOpenRound(userId) {
    const state = loadState(userId);
    if (!state) throw new AppError(400, 'err_no_round');
    return state;
  }

  app.post('/api/game/blackjack/hit', auth, async (req) => {
    const state = requireOpenRound(req.user.id);
    const d = draw(state);
    state.player.push(d(state.cursor++));
    state.actions.push('hit');
    const { total } = bj.handTotal(state.player);
    if (total > 21) {
      return resolveTxn(req.user.id, state); // bust — dealer stays hidden hand as dealt
    }
    if (total === 21) {
      // Nothing sensible left to do — play the dealer out.
      const played = bj.dealerPlay(state.dealer, d, state.cursor);
      state.dealer = played.hand;
      state.cursor = played.cursor;
      return resolveTxn(req.user.id, state);
    }
    stmts.putState.run(req.user.id, JSON.stringify(state), nowISO());
    return { state: publicState(state) };
  });

  const doubleTxn = db.transaction((userId, state) => {
    const row = stmts.balance.get(userId);
    if (row.balance < state.bet) throw new AppError(400, 'err_insufficient_balance');
    stmts.updBalance.run(row.balance - state.bet, userId);
    const d = draw(state);
    state.doubled = true;
    state.actions.push('double');
    state.player.push(d(state.cursor++));
    if (bj.handTotal(state.player).total <= 21) {
      const played = bj.dealerPlay(state.dealer, d, state.cursor);
      state.dealer = played.hand;
      state.cursor = played.cursor;
    }
    return resolveInline(userId, state);
  });

  app.post('/api/game/blackjack/double', auth, async (req) => {
    const state = requireOpenRound(req.user.id);
    if (state.player.length !== 2 || state.doubled) throw new AppError(400, 'err_validation');
    return doubleTxn(req.user.id, state);
  });

  app.post('/api/game/blackjack/stand', auth, async (req) => {
    const state = requireOpenRound(req.user.id);
    const d = draw(state);
    state.actions.push('stand');
    const played = bj.dealerPlay(state.dealer, d, state.cursor);
    state.dealer = played.hand;
    state.cursor = played.cursor;
    return resolveTxn(req.user.id, state);
  });
}
