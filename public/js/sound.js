// Procedurally synthesised sound effects via the Web Audio API. There
// are no audio files: every effect is built from oscillators and one
// short crypto-filled noise buffer, so nothing is downloaded, nothing
// is licensed, and it works offline — matching the project's "original
// or open assets, no extra dependencies" rule. Muting is remembered
// per browser. crypto.getRandomValues (not Math.random) fills the
// noise buffer, keeping the no-Math.random property intact.

// Global loudness multiplier applied to every effect, on top of the
// master gain — tuned up so the table is audible without straining.
const VOL = 1.6;

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = localStorage.getItem('sfx') !== 'off';

function context() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);
  return ctx;
}

function noiseBuffer(c) {
  if (noiseBuf) return noiseBuf;
  const len = Math.floor(c.sampleRate * 0.4);
  noiseBuf = c.createBuffer(1, len, c.sampleRate);
  const data = noiseBuf.getChannelData(0);
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) data[i] = bytes[i] / 127.5 - 1;
  return noiseBuf;
}

function ready() {
  if (!enabled) return null;
  const c = context();
  if (!c) return null;
  if (c.state === 'suspended') c.resume();
  return c;
}

function tone(c, { freq, to, dur = 0.12, type = 'sine', gain = 0.18, when = 0 }) {
  const t0 = c.currentTime + when;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain * VOL, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noise(c, { dur = 0.2, gain = 0.18, type = 'highpass', freq = 1200, when = 0 }) {
  const t0 = c.currentTime + when;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const filt = c.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(gain * VOL, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.03);
}

function arp(c, freqs, { step = 0.09, dur = 0.16, type = 'triangle', gain = 0.18 } = {}) {
  freqs.forEach((f, i) => tone(c, { freq: f, dur, type, gain, when: i * step }));
}

export const sfx = {
  button() {
    const c = ready();
    if (c) tone(c, { freq: 300, to: 170, dur: 0.06, type: 'square', gain: 0.1 });
  },
  chip() {
    const c = ready();
    if (!c) return;
    noise(c, { dur: 0.05, freq: 3500, gain: 0.14 });
    tone(c, { freq: 2400, dur: 0.05, type: 'triangle', gain: 0.08, when: 0.02 });
  },
  deal() {
    const c = ready();
    if (c) noise(c, { dur: 0.09, freq: 1600, type: 'bandpass', gain: 0.16 });
  },
  flip() {
    const c = ready();
    if (c) tone(c, { freq: 520, to: 880, dur: 0.08, type: 'triangle', gain: 0.14 });
  },
  shuffle() {
    const c = ready();
    if (!c) return;
    noise(c, { dur: 0.28, freq: 1800, gain: 0.14 });
    noise(c, { dur: 0.28, freq: 1400, gain: 0.12, when: 0.18 });
  },
  spin() {
    const c = ready();
    if (c) tone(c, { freq: 180, to: 560, dur: 0.6, type: 'sawtooth', gain: 0.07 });
  },
  reelStop() {
    const c = ready();
    if (c) tone(c, { freq: 760, dur: 0.04, type: 'square', gain: 0.1 });
  },
  roll() {
    const c = ready();
    if (c) noise(c, { dur: 0.3, freq: 900, type: 'bandpass', gain: 0.16 });
  },
  win() {
    const c = ready();
    if (c) arp(c, [523, 659, 784], { step: 0.1 });
  },
  big() {
    const c = ready();
    if (c) arp(c, [523, 659, 784, 1047], { step: 0.09, gain: 0.2 });
  },
  lose() {
    const c = ready();
    if (c) arp(c, [392, 294], { step: 0.12, type: 'sawtooth', gain: 0.12, dur: 0.2 });
  },
  push() {
    const c = ready();
    if (c) tone(c, { freq: 440, dur: 0.16, type: 'sine', gain: 0.12 });
  },
  tick(urgent = false) {
    const c = ready();
    if (c) tone(c, { freq: urgent ? 1100 : 820, dur: 0.05, type: 'square', gain: 0.16 });
  },
  isOn() {
    return enabled;
  },
  toggle() {
    enabled = !enabled;
    localStorage.setItem('sfx', enabled ? 'on' : 'off');
    if (enabled) this.button();
    return enabled;
  },
};

/**
 * A sound kit for one slot machine. Each machine on the floor gets its
 * own recipe so the cabinets are told apart with the screen off: a
 * different whirr while the reels run, a different texture when each
 * one lands, a different two-note signature at the end.
 *
 * The result signature deliberately does *not* scale with how much was
 * won. A 2x and a 2000x sound identical, and a zero-net round gets its
 * own flat tone — the amount is reported as a number on screen, not as
 * applause. Nothing here reacts to how close a losing spin came to a
 * win either, because the client is never told.
 *
 * spec = {
 *   loop:  { type, from, to, cut, flutter, gain, air, airGain },
 *   stop:  { type, freq, bend, dur, gain, noiseFreq, noiseGain },
 *   motif: [f1, f2, ...],  wave: OscillatorType
 * }
 */
export function slotKit(spec) {
  let running = null;

  const teardown = (at) => {
    if (!running) return;
    const { c, nodes, env, air } = running;
    running = null;
    const t0 = c.currentTime;
    env.gain.cancelScheduledValues(t0);
    env.gain.setValueAtTime(Math.max(env.gain.value, 0.0001), t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    if (air) {
      air.gain.cancelScheduledValues(t0);
      air.gain.setValueAtTime(Math.max(air.gain.value, 0.0001), t0);
      air.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    }
    for (const n of nodes) {
      try {
        n.stop(t0 + (at || 0.14));
      } catch {
        /* already stopped */
      }
    }
  };

  return {
    /** Start the reel whirr. Safe to call twice. */
    start() {
      this.stop();
      const c = ready();
      if (!c) return;
      const t0 = c.currentTime;
      const s = spec.loop;

      const osc = c.createOscillator();
      osc.type = s.type;
      osc.frequency.setValueAtTime(s.from, t0);
      osc.frequency.exponentialRampToValueAtTime(s.to, t0 + 0.55);

      const filt = c.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = s.cut;
      filt.Q.value = 4;

      // Tremolo stage: the flutter is what reads as reels ticking past.
      const trem = c.createGain();
      trem.gain.value = 0.62;
      const lfo = c.createOscillator();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(s.flutter, t0);
      lfo.frequency.linearRampToValueAtTime(s.flutter * 0.55, t0 + 1.6);
      const depth = c.createGain();
      depth.gain.value = 0.38;
      lfo.connect(depth).connect(trem.gain);

      const env = c.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(s.gain * VOL, t0 + 0.1);
      osc.connect(filt).connect(trem).connect(env).connect(master);

      // A breath of filtered noise so the whirr has some air in it.
      let airSrc = null;
      let airGain = null;
      if (s.airGain) {
        airSrc = c.createBufferSource();
        airSrc.buffer = noiseBuffer(c);
        airSrc.loop = true;
        const band = c.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = s.air;
        band.Q.value = 1.2;
        airGain = c.createGain();
        airGain.gain.setValueAtTime(0.0001, t0);
        airGain.gain.exponentialRampToValueAtTime(s.airGain * VOL, t0 + 0.1);
        airSrc.connect(band).connect(airGain).connect(master);
        airSrc.start(t0);
      }

      osc.start(t0);
      lfo.start(t0);
      running = { c, env, air: airGain, nodes: [osc, lfo, ...(airSrc ? [airSrc] : [])] };
    },

    /** Cut the whirr. Idempotent, and safe when audio never started. */
    stop() {
      teardown();
    },

    /** One reel landing; pitch climbs across the row so it resolves. */
    reel(i = 0, total = 3) {
      const c = ready();
      if (!c) return;
      const s = spec.stop;
      const step = total > 1 ? i / (total - 1) : 0;
      const freq = s.freq * (1 + step * 0.5);
      tone(c, {
        freq,
        to: s.bend ? freq * s.bend : undefined,
        dur: s.dur,
        type: s.type,
        gain: s.gain,
      });
      if (s.noiseGain) {
        noise(c, { dur: s.dur * 0.8, freq: s.noiseFreq, gain: s.noiseGain, type: 'bandpass' });
      }
    },

    /** kind: 'win' (net up) | 'even' (net zero) | 'loss'. */
    result(kind) {
      const c = ready();
      if (!c) return;
      const m = spec.motif;
      if (kind === 'win') {
        arp(c, m, { step: 0.085, dur: 0.24, type: spec.wave, gain: 0.17 });
      } else if (kind === 'even') {
        tone(c, { freq: m[0], dur: 0.18, type: spec.wave, gain: 0.11 });
      } else {
        tone(c, { freq: m[0] / 2, to: m[0] / 2.6, dur: 0.22, type: spec.wave, gain: 0.1 });
      }
    },

    /** The lever. */
    press() {
      const c = ready();
      if (!c) return;
      tone(c, { freq: spec.stop.freq * 0.5, to: spec.stop.freq, dur: 0.09, type: 'square', gain: 0.12 });
    },
  };
}

// Browsers start the audio context suspended until a user gesture.
window.addEventListener(
  'pointerdown',
  () => {
    const c = context();
    if (c && c.state === 'suspended') c.resume();
  },
  { once: true },
);
