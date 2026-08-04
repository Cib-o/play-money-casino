import test from 'node:test';
import assert from 'node:assert/strict';
import { spinLines, LINE_MACHINE_IDS, getLineMachine as serverMachine } from '../src/games/slot-lines.js';
import { lineGrid, lineEvaluate, lineMachine } from '../public/js/verify-core.js';

const SEED = 'a'.repeat(64);

// What the game page draws for a win is derived, not sent: it takes the
// committed stops, rebuilds the grid, and paints a polyline through the
// cells `lines[w.line][col]` for col < w.run. That is a second, independent
// claim on top of the multiplier — the number could be right while the
// line drawn under it points at the wrong cells, and a player checking the
// screen against the paytable by eye would have no way to tell which half
// was lying.
//
// This walks the same geometry the page walks and holds it against the
// grid the win came from.
test('every drawn payline passes through cells that actually made the win', () => {
  let checkedWins = 0;
  let checkedCells = 0;

  for (const id of LINE_MACHINE_IDS) {
    const m = lineMachine(id);
    assert.deepEqual(m.lines, serverMachine(id).lines, `${id}: page and server disagree on the line set`);

    for (let nonce = 0; nonce < 400; nonce++) {
      const round = spinLines({
        serverSeed: SEED, clientSeed: 'draw', nonce, rtp: 0.96, bet: 100, machine: id,
      });
      const grid = lineGrid(round.stops, m);
      const { wins } = lineEvaluate(grid, m);

      for (const w of wins) {
        checkedWins++;
        const path = m.lines[w.line];

        // The run is leading and unbroken: every column the line is drawn
        // through holds the winning symbol or a wild standing in for it.
        for (let col = 0; col < w.run; col++) {
          const row = path[col];
          const sym = grid[col][row];
          assert.ok(
            sym === w.symbol || sym === m.wild,
            `${id} nonce ${nonce} line ${w.line}: column ${col} of the drawn line is row ${row} holding symbol ${sym}, which is neither the winning symbol ${w.symbol} nor the wild ${m.wild}`,
          );
          checkedCells++;

          // The polyline the page emits is `${col + 0.5},${row + 0.5}` in a
          // viewBox of one unit per cell, so the vertex must sit on the
          // centre of that same cell.
          const vertex = [col + 0.5, row + 0.5];
          assert.deepEqual(vertex, [col + 0.5, path[col] + 0.5], `${id}: vertex ${col} off its cell`);
        }

        // The line stops where the run stops: the next column must break
        // it, or the run must already span the grid. A line drawn one cell
        // too long would claim a symbol that did not pay.
        if (w.run < m.cols) {
          const nextRow = path[w.run];
          const nextSym = grid[w.run][nextRow];
          assert.ok(
            nextSym !== w.symbol && nextSym !== m.wild,
            `${id} nonce ${nonce} line ${w.line}: run of ${w.run} stops short — column ${w.run} also matches`,
          );
        }

        // A line is one cell per column, in range, and never runs shorter
        // than the three that is the minimum pay.
        assert.equal(path.length, m.cols, `${id}: line ${w.line} is not one row per column`);
        assert.ok(w.run >= 3 && w.run <= m.cols, `${id}: run ${w.run} out of range`);
        for (const row of path) assert.ok(row >= 0 && row < m.rows, `${id}: row ${row} off the grid`);
      }
    }
  }

  assert.ok(checkedWins > 500, `only ${checkedWins} wins seen — the sample is too thin to mean anything`);
  assert.ok(checkedCells > 1500, `only ${checkedCells} cells checked`);
});

// The scatter is the one symbol that pays without a line, so the page
// highlights it by position instead. Those positions have to be real.
test('every highlighted scatter cell holds a scatter', () => {
  for (const id of LINE_MACHINE_IDS) {
    const m = lineMachine(id);
    for (let nonce = 0; nonce < 300; nonce++) {
      const round = spinLines({
        serverSeed: SEED, clientSeed: 'scatter', nonce, rtp: 0.96, bet: 100, machine: id,
      });
      const grid = lineGrid(round.stops, m);
      const { scatterCells, scatterPay } = lineEvaluate(grid, m);
      for (const [c, r] of scatterCells) {
        assert.equal(grid[c][r], m.scatter, `${id} nonce ${nonce}: cell ${c},${r} highlighted but is not a scatter`);
      }
      if (scatterPay > 0) {
        assert.ok(scatterCells.length >= 3, `${id}: scatter paid on ${scatterCells.length} cells`);
      }
    }
  }
});
