// Display table for the retired ladder machines in src/games/slots.js.
// None of these cabinets is on the floor any more — the payline
// machines in slot-line-art.js are what a player sees. What is left
// here is what /verify needs to show a round recorded before the
// retirement: the symbol row and the machine's name. Timings, landing
// style and sound are kept alongside them so the table stays one
// description of one machine rather than a stripped fragment.
//
// Symbols are ordered from the lowest multiplier to the highest, so
// index i in a reel array is `symbols[i]`, and the count must match the
// machine's paytable length (`test/slots.test.js` checks this).

export const THEMES = {
  orchard: {
    id: 'orchard',
    art: '🌻',
    symbols: ['🍎', '🍐', '🍓', '🌻', '🍯', '🦋', '🌈'],
    run: 620,
    gap: 130,
    land: 'bounce',
    sound: {
      loop: { type: 'triangle', from: 220, to: 300, cut: 1400, flutter: 12, gain: 0.05, air: 2600, airGain: 0.015 },
      stop: { type: 'sine', freq: 660, bend: 0.75, dur: 0.12, gain: 0.14, noiseFreq: 3200, noiseGain: 0.03 },
      motif: [587.33, 880],
      wave: 'sine',
    },
  },

  abyss: {
    id: 'abyss',
    art: '🐙',
    symbols: ['🐚', '🐠', '🪸', '🦐', '🐙', '🦑', '🔱', '💠'],
    run: 900,
    gap: 210,
    land: 'drift',
    sound: {
      loop: { type: 'sine', from: 80, to: 130, cut: 600, flutter: 7, gain: 0.07, air: 700, airGain: 0.035 },
      stop: { type: 'sine', freq: 380, bend: 1.6, dur: 0.24, gain: 0.13, noiseFreq: 900, noiseGain: 0.03 },
      motif: [392, 523.25],
      wave: 'sine',
    },
  },

  neon: {
    id: 'neon',
    art: '🤖',
    symbols: ['🎧', '🕹️', '📼', '🛸', '🌀', '🔮', '⚡', '🤖'],
    run: 560,
    gap: 95,
    land: 'glitch',
    sound: {
      loop: { type: 'square', from: 90, to: 190, cut: 1800, flutter: 26, gain: 0.055, air: 3800, airGain: 0.03 },
      stop: { type: 'sawtooth', freq: 900, bend: 0.35, dur: 0.06, gain: 0.12, noiseFreq: 5200, noiseGain: 0.06 },
      motif: [440, 622.25, 880],
      wave: 'sawtooth',
    },
  },

  classic: {
    id: 'classic',
    art: '🎰',
    symbols: ['🍋', '🍒', '🍇', '🔔', '⭐', '💎', '7️⃣', '👑', '🎰'],
    run: 700,
    gap: 145,
    land: 'clunk',
    sound: {
      loop: { type: 'sawtooth', from: 150, to: 210, cut: 900, flutter: 17, gain: 0.06, air: 1500, airGain: 0.02 },
      stop: { type: 'square', freq: 420, bend: 0.55, dur: 0.07, gain: 0.13, noiseFreq: 2400, noiseGain: 0.07 },
      motif: [523.25, 659.25, 783.99],
      wave: 'triangle',
    },
  },

  temple: {
    id: 'temple',
    art: '🗿',
    symbols: ['🪶', '🏺', '🗿', '🐍', '🦂', '🔥', '☀️', '🦅', '💰'],
    run: 850,
    gap: 240,
    land: 'heavy',
    sound: {
      loop: { type: 'sawtooth', from: 70, to: 105, cut: 520, flutter: 9, gain: 0.075, air: 1100, airGain: 0.03 },
      stop: { type: 'triangle', freq: 180, bend: 0.5, dur: 0.2, gain: 0.16, noiseFreq: 1300, noiseGain: 0.08 },
      motif: [349.23, 466.16, 698.46],
      wave: 'triangle',
    },
  },

  cosmos: {
    id: 'cosmos',
    art: '🪐',
    symbols: ['🛰️', '☄️', '🌙', '🪐', '🌠', '🌌', '🌟'],
    run: 760,
    gap: 115,
    land: 'shimmer',
    sound: {
      loop: { type: 'sine', from: 300, to: 520, cut: 2600, flutter: 31, gain: 0.045, air: 6000, airGain: 0.025 },
      stop: { type: 'sine', freq: 1200, bend: 2.1, dur: 0.16, gain: 0.11, noiseFreq: 7000, noiseGain: 0.025 },
      motif: [659.25, 987.77, 1318.51],
      wave: 'sine',
    },
  },
};

// Rounds recorded before the floor had more than one machine carry no
// machine id; they were all played on `classic`.
export const FALLBACK_THEME = THEMES.classic;

export function theme(id) {
  return THEMES[id] || FALLBACK_THEME;
}
