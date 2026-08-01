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

// Browsers start the audio context suspended until a user gesture.
window.addEventListener(
  'pointerdown',
  () => {
    const c = context();
    if (c && c.state === 'suspended') c.resume();
  },
  { once: true },
);
