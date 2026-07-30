import { randomInt, randomUUID } from 'node:crypto';
import { uniform, newSeedPair } from './rng.js';
import { handTotal, isBlackjack, dealerPlay, settleOutcome } from './games/blackjack.js';
import { readSettings, nowISO } from './db.js';
import { AppError } from './errors.js';

// ── Shared, server-authoritative blackjack table ──────────────────
// A single table lives in this Node process and runs its own round
// loop on timers, independent of any browser: bots keep it moving even
// with nobody watching, refreshing a page just re-reads the current
// state, and any number of signed-in players can take a seat on the
// same table. Clients poll snapshot() for state and drive their seat
// through join()/action()/leave().
//
// Fairness is per round and per seat. At the start of each round the
// server commits sha256(server_seed); every card is
// HMAC-SHA256(server_seed, `table:<seatTag>:<nonce>:<cursor>`) mapped
// to 0..51 (seatTag = seat index, or 'd' for the dealer). The seed is
// revealed at payout, so each seated player's round — recorded in the
// rounds table with that seat's client seed — reproduces on /verify,
// exactly like the single-hand game.

export const SEAT_COUNT = 7;
export const TABLE_CLIENT_SEED = 'table';

const BETTING_MS = 12000;
const TURN_MS = 15000;
const DEALER_MS = 1600;
const PAYOUT_MS = 5000;
const BOT_MIN_THINK = 600;
const BOT_MAX_THINK = 1900;
const SEAT_IDLE_MS = 30000; // free a seat whose player stopped polling

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function maskedName() {
  const len = 4 + randomInt(6);
  let raw = '';
  for (let i = 0; i < len; i++) raw += ALNUM[randomInt(ALNUM.length)];
  return raw[0] + '*'.repeat(len - 2) + raw[len - 1];
}
function think() {
  return BOT_MIN_THINK + randomInt(BOT_MAX_THINK - BOT_MIN_THINK);
}

// Card index 0..51 for a seat's cursor in the committed round.
function cardAt(serverSeed, seatTag, nonce, cursor) {
  return Math.floor(uniform(serverSeed, `${TABLE_CLIENT_SEED}:${seatTag}`, nonce, cursor) * 52);
}

// Simplified basic strategy for the server-side bots (hit/stand/double).
function botMove(hand, dealerUp) {
  const { total, soft } = handTotal(hand);
  const up = dealerUp === undefined ? 7 : cardValueUp(dealerUp);
  if (hand.length === 2 && (total === 10 || total === 11) && up <= 9 && randomInt(3) === 0) {
    return 'double';
  }
  if (soft) return total <= 17 ? 'hit' : 'stand';
  if (total <= 11) return 'hit';
  if (total >= 17) return 'stand';
  return up >= 7 ? 'hit' : 'stand';
}
function cardValueUp(card) {
  const r = card % 13;
  if (r === 0) return 11;
  if (r >= 9) return 10;
  return r + 1;
}

function botResult(hand, dealer) {
  const p = handTotal(hand).total;
  const d = handTotal(dealer).total;
  if (isBlackjack(hand) && !isBlackjack(dealer)) return 'blackjack';
  if (p > 21) return 'lose';
  if (isBlackjack(dealer) && !isBlackjack(hand)) return 'lose';
  if (d > 21 || p > d) return 'win';
  if (p < d) return 'lose';
  return 'push';
}

function emptySeat(index) {
  return {
    index,
    kind: 'empty',
    userId: null,
    name: null,
    bet: 0,
    baseBet: 0,
    hand: [],
    actions: [],
    cursor: 1,
    done: false,
    doubled: false,
    result: null,
    roundRowId: null,
    lastSeen: 0,
  };
}

export function createBlackjackTable(db) {
  const stmts = {
    balance: db.prepare('SELECT balance FROM users WHERE id = ?'),
    setBalance: db.prepare('UPDATE users SET balance = ? WHERE id = ?'),
    insertRound: db.prepare(
      `INSERT INTO rounds (id, user_id, game, bet, payout, net, outcome_json,
                           server_seed_hash, server_seed, client_seed, nonce, created_at)
       VALUES (?, ?, 'blackjack', ?, 0, ?, ?, ?, NULL, ?, ?, ?)`,
    ),
    finalizeRound: db.prepare(
      `UPDATE rounds SET payout = ?, net = ?, outcome_json = ?, server_seed = ?, bet = ? WHERE id = ?`,
    ),
  };

  const state = {
    phase: 'betting',
    phaseEndsAt: Date.now() + BETTING_MS,
    turnEndsAt: 0,
    nonce: 0,
    serverSeed: '',
    serverSeedHash: '',
    revealed: false,
    activeSeat: -1,
    version: 0,
    seats: Array.from({ length: SEAT_COUNT }, (_, i) => emptySeat(i)),
    dealer: { cards: [], revealed: false },
  };

  let epoch = 0;
  let timers = new Set();
  let running = false;

  function later(ms, fn) {
    const myEpoch = epoch;
    const id = setTimeout(() => {
      timers.delete(id);
      if (running && myEpoch === epoch) fn();
    }, ms);
    timers.add(id);
    return id;
  }
  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers = new Set();
  }

  function seatOf(userId) {
    return state.seats.find((s) => s.kind === 'player' && s.userId === userId) || null;
  }

  function assignBots() {
    const empties = state.seats.filter((s) => s.kind === 'empty');
    const target = 2 + randomInt(3); // 2–4 bots
    for (let i = 0; i < target && empties.length; i++) {
      const seat = empties.splice(randomInt(empties.length), 1)[0];
      seat.kind = 'bot';
      seat.name = maskedName();
    }
  }

  function resetSeatForRound(seat) {
    seat.hand = [];
    seat.actions = [];
    seat.cursor = 1;
    seat.done = false;
    seat.doubled = false;
    seat.result = null;
    seat.roundRowId = null;
    seat.baseBet = 0;
  }

  // ── phase: betting ──────────────────────────────────────────────
  function startBetting() {
    epoch++;
    const settings = readSettings(db);
    const now = Date.now();
    for (const seat of state.seats) {
      if (seat.kind === 'bot') Object.assign(seat, emptySeat(seat.index));
      else if (seat.kind === 'player') {
        // drop players who stopped polling; keep the rest seated
        if (now - seat.lastSeen > SEAT_IDLE_MS) Object.assign(seat, emptySeat(seat.index));
        else {
          resetSeatForRound(seat);
          seat.bet = 0;
        }
      }
    }
    assignBots();
    // bots pick a cosmetic bet
    const max = settings.maxBet;
    for (const seat of state.seats) {
      if (seat.kind === 'bot') seat.bet = [5, 25, 100].filter((v) => v <= max)[randomInt(3)] || settings.minBet;
    }
    const pair = newSeedPair();
    state.serverSeed = pair.serverSeed;
    state.serverSeedHash = pair.hash;
    state.revealed = false;
    state.nonce += 1;
    state.dealer = { cards: [], revealed: false };
    state.activeSeat = -1;
    state.phase = 'betting';
    state.phaseEndsAt = Date.now() + BETTING_MS;
    state.version++;
    later(BETTING_MS, closeBetting);
  }

  // ── phase: deal ─────────────────────────────────────────────────
  const chargeInitial = db.transaction((seat) => {
    const row = stmts.balance.get(seat.userId);
    if (!row || row.balance < seat.bet) return false;
    stmts.setBalance.run(row.balance - seat.bet, seat.userId);
    seat.baseBet = seat.bet;
    seat.roundRowId = randomUUID();
    const outcome = { table: true, seat: seat.index, player: [], dealer: [], actions: [], doubled: false, result: null };
    stmts.insertRound.run(
      seat.roundRowId, seat.userId, seat.bet, -seat.bet, JSON.stringify(outcome),
      state.serverSeedHash, `${TABLE_CLIENT_SEED}:${seat.index}`, state.nonce, nowISO(),
    );
    return true;
  });

  function closeBetting() {
    // charge and seat everyone who committed a bet; bots always play
    for (const seat of state.seats) {
      if (seat.kind === 'player') {
        if (seat.bet <= 0) continue; // sitting this round out
        if (!chargeInitial(seat)) {
          seat.bet = 0; // could not afford — sit out
        }
      }
    }
    // deal two cards to every seat that is in the round, plus the dealer
    for (const seat of state.seats) {
      if (!inRound(seat)) continue;
      seat.hand = [
        cardAt(state.serverSeed, String(seat.index), state.nonce, 0),
        cardAt(state.serverSeed, String(seat.index), state.nonce, 1),
      ];
      seat.cursor = 1;
      if (isBlackjack(seat.hand)) seat.done = true;
    }
    state.dealer.cards = [
      cardAt(state.serverSeed, 'd', state.nonce, 0),
      cardAt(state.serverSeed, 'd', state.nonce, 1),
    ];
    state.dealer.revealed = false;
    state.phase = 'acting';
    state.activeSeat = -1;
    state.version++;
    nextTurn();
  }

  function inRound(seat) {
    return (seat.kind === 'bot') || (seat.kind === 'player' && seat.baseBet > 0);
  }

  // ── phase: acting ───────────────────────────────────────────────
  function nextTurn() {
    let i = state.activeSeat + 1;
    while (i < SEAT_COUNT) {
      const seat = state.seats[i];
      if (inRound(seat) && !seat.done) break;
      i++;
    }
    if (i >= SEAT_COUNT) {
      state.activeSeat = -1;
      return beginDealer();
    }
    state.activeSeat = i;
    state.turnEndsAt = 0;
    state.version++;
    const seat = state.seats[i];
    if (seat.kind === 'bot') scheduleBot(i);
    else {
      state.turnEndsAt = Date.now() + TURN_MS;
      later(TURN_MS, () => {
        if (state.activeSeat === i && !seat.done) {
          seat.actions.push('stand');
          seat.done = true;
          state.version++;
          nextTurn();
        }
      });
    }
  }

  function scheduleBot(i) {
    later(think(), () => {
      if (state.activeSeat !== i) return;
      const seat = state.seats[i];
      const total = handTotal(seat.hand).total;
      const move = total >= 21 ? 'stand' : botMove(seat.hand, state.dealer.cards[0]);
      if (move === 'stand') {
        seat.actions.push('stand');
        seat.done = true;
        state.version++;
        nextTurn();
        return;
      }
      seat.cursor += 1;
      seat.hand.push(cardAt(state.serverSeed, String(i), state.nonce, seat.cursor));
      seat.actions.push(move);
      state.version++;
      if (move === 'double' || handTotal(seat.hand).total >= 21) {
        seat.done = true;
        nextTurn();
        return;
      }
      scheduleBot(i);
    });
  }

  const chargeDouble = db.transaction((seat) => {
    const row = stmts.balance.get(seat.userId);
    if (!row || row.balance < seat.baseBet) return false;
    stmts.setBalance.run(row.balance - seat.baseBet, seat.userId);
    return true;
  });

  // ── phase: dealer + payout ──────────────────────────────────────
  function beginDealer() {
    state.phase = 'dealer';
    state.dealer.revealed = true;
    // dealer's first two cards are cursors 0 and 1; draws continue at 2
    const played = dealerPlay(
      state.dealer.cards,
      (c) => cardAt(state.serverSeed, 'd', state.nonce, c),
      2,
    );
    state.dealer.cards = played.hand;
    state.version++;
    later(DEALER_MS, doPayout);
  }

  const finalize = db.transaction((seat, dealer, settled) => {
    const row = stmts.balance.get(seat.userId);
    const stake = seat.doubled ? seat.baseBet * 2 : seat.baseBet;
    stmts.setBalance.run(row.balance + settled.payout, seat.userId);
    const outcome = {
      table: true,
      seat: seat.index,
      player: seat.hand,
      dealer,
      actions: seat.actions,
      doubled: seat.doubled,
      result: settled.result,
    };
    stmts.finalizeRound.run(
      settled.payout, settled.payout - stake, JSON.stringify(outcome),
      state.serverSeed, stake, seat.roundRowId,
    );
  });

  function doPayout() {
    state.phase = 'payout';
    state.revealed = true;
    const dealer = state.dealer.cards;
    for (const seat of state.seats) {
      if (seat.kind === 'player' && seat.roundRowId) {
        const settled = settleOutcome(seat.hand, dealer, { bet: seat.baseBet, doubled: seat.doubled });
        seat.result = settled.result;
        finalize(seat, dealer, settled);
      } else if (seat.kind === 'bot' && seat.hand.length) {
        seat.result = botResult(seat.hand, dealer);
      }
    }
    state.phaseEndsAt = Date.now() + PAYOUT_MS;
    state.version++;
    later(PAYOUT_MS, startBetting);
  }

  // ── public API ──────────────────────────────────────────────────
  function publicDealer() {
    if (state.dealer.revealed) {
      return { cards: state.dealer.cards, total: handTotal(state.dealer.cards).total, revealed: true };
    }
    const up = state.dealer.cards[0];
    return { cards: up === undefined ? [] : [up], total: up === undefined ? 0 : handTotal([up]).total, revealed: false };
  }

  function publicSeat(seat, userId) {
    const you = seat.kind === 'player' && seat.userId === userId;
    return {
      index: seat.index,
      occupied: seat.kind !== 'empty',
      is_you: you,
      is_bot: seat.kind === 'bot',
      name: seat.kind === 'empty' ? null : seat.name,
      bet: seat.bet,
      hand: seat.hand,
      total: seat.hand.length ? handTotal(seat.hand).total : 0,
      done: seat.done,
      result: state.phase === 'payout' ? seat.result : null,
      active: seat.index === state.activeSeat,
    };
  }

  function snapshot(user) {
    const mySeat = user ? seatOf(user.id) : null;
    if (mySeat) mySeat.lastSeen = Date.now();
    const settings = readSettings(db);
    const balance = user ? (stmts.balance.get(user.id)?.balance ?? 0) : 0;
    const freeSeat = state.seats.some((s) => s.kind === 'empty');
    return {
      phase: state.phase,
      ends_at: state.phaseEndsAt,
      turn_ends_at: state.turnEndsAt,
      now: Date.now(),
      nonce: state.nonce,
      server_seed_hash: state.serverSeedHash,
      server_seed: state.revealed ? state.serverSeed : null,
      client_seed: TABLE_CLIENT_SEED,
      active_seat: state.activeSeat,
      your_seat: mySeat ? mySeat.index : -1,
      your_bet: mySeat ? mySeat.bet : 0,
      your_balance: balance,
      can_join: state.phase === 'betting' && (mySeat != null || freeSeat),
      can_bet: state.phase === 'betting',
      min_bet: settings.minBet,
      max_bet: settings.maxBet,
      version: state.version,
      dealer: publicDealer(),
      seats: state.seats.map((s) => publicSeat(s, user ? user.id : null)),
    };
  }

  function join(user, bet) {
    if (state.phase !== 'betting') throw new AppError(400, 'err_betting_closed');
    const settings = readSettings(db);
    if (!Number.isInteger(bet) || bet < settings.minBet) throw new AppError(400, 'err_bet_too_small');
    if (bet > settings.maxBet) throw new AppError(400, 'err_bet_too_large');
    const balance = stmts.balance.get(user.id)?.balance ?? 0;
    if (bet > balance) throw new AppError(400, 'err_insufficient_balance');
    let seat = seatOf(user.id);
    if (!seat) {
      seat = state.seats.find((s) => s.kind === 'empty');
      if (!seat) throw new AppError(400, 'err_table_full');
      Object.assign(seat, emptySeat(seat.index));
      seat.kind = 'player';
      seat.userId = user.id;
      seat.name = maskedName();
    }
    seat.bet = bet;
    seat.lastSeen = Date.now();
    state.version++;
    return snapshot(user);
  }

  function leave(user) {
    const seat = seatOf(user.id);
    if (!seat) return snapshot(user);
    // only safe to free before cards are dealt; mid-round just stop rebetting
    if (state.phase === 'betting') Object.assign(seat, emptySeat(seat.index));
    else seat.bet = 0;
    state.version++;
    return snapshot(user);
  }

  function action(user, move) {
    const seat = seatOf(user.id);
    if (!seat) throw new AppError(400, 'err_no_round');
    seat.lastSeen = Date.now();
    if (state.activeSeat !== seat.index || seat.done) throw new AppError(400, 'err_not_your_turn');
    if (move === 'double') {
      if (seat.hand.length !== 2 || seat.doubled) throw new AppError(400, 'err_validation');
      if (!chargeDouble(seat)) throw new AppError(400, 'err_insufficient_balance');
      seat.doubled = true;
      seat.bet = seat.baseBet * 2;
    }
    if (move === 'hit' || move === 'double') {
      seat.cursor += 1;
      seat.hand.push(cardAt(state.serverSeed, String(seat.index), state.nonce, seat.cursor));
      seat.actions.push(move);
      if (move === 'double' || handTotal(seat.hand).total >= 21) {
        seat.done = true;
        state.version++;
        nextTurn();
      } else {
        state.version++;
      }
    } else if (move === 'stand') {
      seat.actions.push('stand');
      seat.done = true;
      state.version++;
      nextTurn();
    } else {
      throw new AppError(400, 'err_validation');
    }
    return snapshot(user);
  }

  function start() {
    if (running) return;
    running = true;
    startBetting();
  }
  function stop() {
    running = false;
    clearTimers();
  }

  return { snapshot, join, leave, action, start, stop, SEAT_COUNT };
}
