import * as ladder from './slots.js';
import * as lines from './slot-lines.js';

// The floor runs on `slot-lines.js`: a real reel-strip machine where the
// stops are drawn first and the win falls out of what lands on the
// paylines.
//
// `slots.js` is the older outcome-first ladder — one uniform draw picks a
// multiplier from a calibrated table and the reels are chosen afterwards
// to display it. Its cabinets have been retired from the floor and
// cannot be played. The engine itself stays, and stays tested, because
// every slots round recorded before the retirement was resolved by it:
// deleting the code would make those rounds fail verification, and a
// provably fair claim you break the moment you change the line-up is not
// a claim worth making. It is a replay path now, nothing more.
//
// This module is the only place that knows both exist. Routes and the
// client talk to it, not to either engine directly.

/** The playable floor, calmest cabinet first. */
export const FLOOR_IDS = [...lines.LINE_MACHINE_IDS];

/** The cabinet a spin request that names no machine is played on. */
export const FLOOR_DEFAULT = lines.LINE_MACHINE_IDS[0];

/**
 * The id a *recorded* round with no machine of its own replays as.
 * Frozen to `classic`: rounds from before the floor existed carry no
 * machine id, and they must keep resolving to the ladder they were
 * played on. This is a replay constant, not a playable default — see
 * `FLOOR_DEFAULT` for that.
 */
export const DEFAULT_MACHINE = ladder.DEFAULT_MACHINE;

/** `'lines'` or `'ladder'`. Unknown ids resolve to the default engine. */
export function kindOf(id) {
  return lines.LINE_MACHINES[id] ? 'lines' : 'ladder';
}

export function isFloorMachine(id) {
  return FLOOR_IDS.includes(id);
}

/**
 * What the client is told about one machine. Both engines report a
 * standard deviation on the same scale — a fraction of the total bet —
 * so the same band thresholds order the whole floor, and the badge a
 * player sees is derived from the paytable rather than hand-assigned.
 */
export function floorView(id, rtp) {
  if (kindOf(id) === 'lines') {
    const view = lines.lineMachineView(id, rtp);
    return { ...view, volatility: ladder.volatilityBand(view.sd) };
  }
  return { ...ladder.machineView(id, rtp), kind: 'ladder' };
}

/** Every machine on the floor, in display order. */
export function floorViews(rtp) {
  return FLOOR_IDS.map((id) => floorView(id, rtp));
}

/**
 * Resolve one spin on whichever engine owns the machine.
 *
 * The two engines return different shapes because they are different
 * games — a ladder round is a multiplier and a row of symbols, a payline
 * round is a grid and a list of winning lines. Rather than flatten them
 * into a lowest common denominator, the outcome keeps its own shape and
 * carries a `kind` so the client and the verifier know how to read it.
 */
export function spinFloor({ serverSeed, clientSeed, nonce, rtp, bet, machine }) {
  if (kindOf(machine) === 'lines') {
    return lines.spinLines({ serverSeed, clientSeed, nonce, rtp, bet, machine });
  }
  return { ...ladder.spin({ serverSeed, clientSeed, nonce, rtp, bet, machine }), kind: 'ladder' };
}

/**
 * The outcome recorded on the round row. Only what is needed to replay
 * the spin is stored: for a payline round that is the reel stops, since
 * the grid and every winning line are derived from them. Storing the
 * derived grid too would let the two disagree.
 */
export function outcomeOf(out, rtp) {
  if (out.kind === 'lines') {
    return { rtp, machine: out.machine, kind: 'lines', mult: out.mult, stops: out.stops };
  }
  return { rtp, machine: out.machine, mult: out.mult, reels: out.reels };
}
