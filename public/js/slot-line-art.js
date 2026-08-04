// Presentation for the payline cabinets in src/games/slot-lines.js.
//
// Deliberately a separate table from THEMES in slot-themes.js. Those
// machines draw a single row of emoji off a multiplier ladder; these
// draw a grid of sprites and light up paylines, so nothing but the
// timing fields is shared and merging them would only mean two kinds of
// entry in one object. Everything here is cosmetic: the server has
// already fixed the reel stops before a frame is drawn, and the
// animation is only ever handed the finished grid.
//
// Symbol names come from the server view, not from here — the artwork
// is looked up by key so a registry change can never leave the grid
// showing the wrong sprite. `artFor` is the whole mapping.

/** Path to the sprite for a symbol key from the server registry. */
export function artFor(key) {
  return `/assets/symbols/gem-${key}.png`;
}

// `run` is the minimum time the reels turn, `gap` the pause between one
// column landing and the next, `land` the CSS landing animation, and
// `lead` the symbol whose sprite fronts the cabinet on the floor.
export const LINE_ART = {
  meadow: {
    id: 'meadow',
    lead: 'diamond-green',
    run: 640,
    gap: 120,
    land: 'bounce',
    sound: {
      loop: { type: 'triangle', from: 200, to: 285, cut: 1300, flutter: 13, gain: 0.05, air: 2400, airGain: 0.018 },
      stop: { type: 'sine', freq: 620, bend: 0.8, dur: 0.13, gain: 0.13, noiseFreq: 3000, noiseGain: 0.028 },
      motif: [523.25, 659.25, 880],
      wave: 'sine',
    },
  },

  vault: {
    id: 'vault',
    lead: 'diamond-purple',
    run: 760,
    gap: 150,
    land: 'clunk',
    sound: {
      loop: { type: 'sawtooth', from: 120, to: 175, cut: 780, flutter: 19, gain: 0.06, air: 1400, airGain: 0.025 },
      stop: { type: 'square', freq: 340, bend: 0.6, dur: 0.09, gain: 0.14, noiseFreq: 2200, noiseGain: 0.07 },
      motif: [392, 523.25, 622.25],
      wave: 'triangle',
    },
  },

  ember: {
    id: 'ember',
    lead: 'diamond-red',
    run: 820,
    gap: 175,
    land: 'heavy',
    sound: {
      loop: { type: 'sawtooth', from: 85, to: 140, cut: 620, flutter: 11, gain: 0.07, air: 1200, airGain: 0.035 },
      stop: { type: 'triangle', freq: 220, bend: 0.55, dur: 0.18, gain: 0.15, noiseFreq: 1500, noiseGain: 0.075 },
      motif: [349.23, 466.16, 698.46],
      wave: 'triangle',
    },
  },

  monolith: {
    id: 'monolith',
    lead: 'diamond-yellow',
    run: 940,
    gap: 195,
    land: 'drift',
    sound: {
      loop: { type: 'sine', from: 62, to: 108, cut: 480, flutter: 6, gain: 0.075, air: 820, airGain: 0.04 },
      stop: { type: 'sine', freq: 290, bend: 1.5, dur: 0.26, gain: 0.13, noiseFreq: 950, noiseGain: 0.035 },
      motif: [261.63, 392, 587.33],
      wave: 'sine',
    },
  },
};

export function lineArt(id) {
  return LINE_ART[id];
}
