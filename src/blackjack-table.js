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
    net: 0,
    roundRowId: null,
    lastSeen: 0,
  };
}

// Nobody is dealt a hand without a wager behind it. For a player that
// means a bet the table actually charged (`baseBet`); for a bot it means
// the one manageBots gave it, which is 0 for the ~22% that sit the round
// out. Dealing to those anyway put cards on a seat with an empty
// betspot — a hand nobody had staked anything on, which is both wrong
// and, from the other chairs, unreadable: you could not tell a
// sitting-out neighbour from one whose chip had failed to draw.
export function inRound(seat) {
  if (seat.kind === 'bot') return seat.bet > 0;
  return seat.kind === 'player' && seat.baseBet > 0;
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
    stakeRound: db.prepare('UPDATE rounds SET bet = ?, net = ? WHERE id = ?'),
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
  // Bots ebb and flow like a real room: a baseline number of bots that
  // drifts every 45–120 minutes, so some hours are busy and some quiet.
  let botBaseline = 3;
  let botBaselineUntil = 0;

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

  const botCount = () => state.seats.filter((s) => s.kind === 'bot').length;

  function updateBotBaseline(maxBots) {
    if (Date.now() < botBaselineUntil && botBaseline <= maxBots) return;
    if (maxBots <= 0) {
      botBaseline = 0;
    } else {
      botBaseline = 1 + randomInt(maxBots); // 1..maxBots
      if (randomInt(100) < 30) botBaseline = 1 + randomInt(Math.min(2, maxBots)); // quieter stretch
      botBaseline = Math.min(botBaseline, maxBots);
    }
    botBaselineUntil = Date.now() + (45 + randomInt(75)) * 60 * 1000;
  }

  // Bots leave, arrive and choose to bet or sit out each betting window,
  // so the table population and participation feel human rather than a
  // fixed set of players that always plays.
  function manageBots(settings) {
    botBaseline = Math.min(botBaseline, settings.maxBots);
    for (const seat of state.seats) {
      if (seat.kind !== 'bot') continue;
      const over = botCount() > botBaseline;
      if (randomInt(100) < (over ? 35 : 7)) Object.assign(seat, emptySeat(seat.index));
    }
    let guard = 0;
    while (botCount() < botBaseline && guard++ < SEAT_COUNT) {
      const empties = state.seats.filter((s) => s.kind === 'empty');
      if (!empties.length) break;
      if (botCount() > 0 && randomInt(100) >= 55) break; // trickle in after the first
      const seat = empties[randomInt(empties.length)];
      seat.kind = 'bot';
      seat.name = maskedName();
      seat.lastSeen = Date.now();
    }
    const opts = [5, 25, 100].filter((v) => v <= settings.maxBet);
    for (const seat of state.seats) {
      if (seat.kind !== 'bot') continue;
      if (randomInt(100) < 22) seat.bet = 0; // sit this round out
      else seat.bet = opts.length ? opts[randomInt(opts.length)] : settings.minBet;
    }
  }

  function resetSeatForRound(seat) {
    seat.hand = [];
    seat.actions = [];
    seat.cursor = 1;
    seat.done = false;
    seat.doubled = false;
    seat.result = null;
    seat.net = 0;
    seat.roundRowId = null;
    seat.baseBet = 0;
  }

  // ── phase: betting ──────────────────────────────────────────────
  function startBetting() {
    epoch++;
    const settings = readSettings(db);
    const now = Date.now();
    for (const seat of state.seats) {
      if (seat.kind === 'player') {
        // drop players who stopped polling; keep the rest seated
        if (now - seat.lastSeen > SEAT_IDLE_MS) Object.assign(seat, emptySeat(seat.index));
        else {
          resetSeatForRound(seat);
          seat.bet = 0;
        }
      } else if (seat.kind === 'bot') {
        // bots persist across rounds; manageBots decides who stays/plays
        resetSeatForRound(seat);
        seat.bet = 0;
      }
    }
    updateBotBaseline(settings.maxBots);
    manageBots(settings);
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
    // charge everyone who committed a valid bet; whoever is left with a
    // stake — player or bot — is in the round
    const settings = readSettings(db);
    for (const seat of state.seats) {
      if (seat.kind === 'player') {
        if (seat.bet < settings.minBet) {
          seat.bet = 0; // below the minimum → sit this round out
          continue;
        }
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
    // occasional long "away" pause, otherwise a normal thinking beat
    const afk = randomInt(100) < 12;
    const wait = (afk ? 2500 : 450) + randomInt(afk ? 2600 : 1400);
    later(wait, () => {
      if (state.activeSeat !== i) return;
      const seat = state.seats[i];
      const total = handTotal(seat.hand).total;
      let move;
      if (total >= 21) {
        move = 'stand';
      } else {
        const r = randomInt(100);
        if (r < 12) move = 'hit'; // takes a card for no reason
        else if (r < 24) move = 'stand'; // stands early
        else move = botMove(seat.hand, state.dealer.cards[0]); // basic strategy
      }
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
    // The stake on the row moves with the money, in the same
    // transaction. From here until finalize the player is down two bets,
    // and if the process dies in that window the row is the only
    // surviving record of it — left standing at one bet it would show a
    // credit less lost than actually left the balance, and the floor
    // total would never add up again.
    stmts.stakeRound.run(seat.baseBet * 2, -seat.baseBet * 2, seat.roundRowId);
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
        // what the round moved, ready to read: the table already knows
        // it, and the alternative is the page re-deriving 3:2 rounding
        // and the doubled stake from a bet and a result string.
        seat.net = settled.payout - (seat.doubled ? seat.baseBet * 2 : seat.baseBet);
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
      // your own money only — what the neighbours won is theirs to know
      net: you && state.phase === 'payout' ? seat.net : 0,
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

  // Take a specific empty seat (or move to one). Betting/amount is a
  // separate step, so a player picks their spot first, then bets.
  function sit(user, seatIndex) {
    if (state.phase !== 'betting') throw new AppError(400, 'err_betting_closed');
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= SEAT_COUNT) {
      throw new AppError(400, 'err_validation');
    }
    const current = seatOf(user.id);
    if (current && current.index === seatIndex) return snapshot(user);
    const target = state.seats[seatIndex];
    if (target.kind !== 'empty') throw new AppError(400, 'err_seat_taken');
    if (current) Object.assign(current, emptySeat(current.index)); // moving resets the bet
    Object.assign(target, emptySeat(seatIndex));
    target.kind = 'player';
    target.userId = user.id;
    target.name = maskedName();
    target.lastSeen = Date.now();
    state.version++;
    return snapshot(user);
  }

  // Set the bet on the seat the player already holds. Amounts may build
  // up below the minimum while placing chips; sub-minimum bets simply
  // sit the round out at deal time and are never charged.
  function bet(user, amount) {
    if (state.phase !== 'betting') throw new AppError(400, 'err_betting_closed');
    const seat = seatOf(user.id);
    if (!seat) throw new AppError(400, 'err_no_seat');
    const settings = readSettings(db);
    if (!Number.isInteger(amount) || amount < 0) throw new AppError(400, 'err_validation');
    if (amount > settings.maxBet) throw new AppError(400, 'err_bet_too_large');
    const balance = stmts.balance.get(user.id)?.balance ?? 0;
    if (amount > balance) throw new AppError(400, 'err_insufficient_balance');
    seat.bet = amount;
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

  // Called when an admin deletes a player: free their seat so the round
  // loop never references a user row that no longer exists.
  function removeUser(userId) {
    const seat = seatOf(userId);
    if (seat) {
      Object.assign(seat, emptySeat(seat.index));
      state.version++;
    }
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

  return { snapshot, sit, bet, leave, action, removeUser, start, stop, SEAT_COUNT };
}
