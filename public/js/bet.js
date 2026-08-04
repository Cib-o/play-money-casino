import { el } from './shell.js';
import { CREDIT } from './i18n.js';

/**
 * Shared bet control: − / + steppers, quick-bet chips and MAX.
 *
 * Everything crossing this boundary — min, max, getBalance(), .value —
 * is in hundredths of a credit, the same unit the server speaks. Only
 * the box the player types in holds credits, and the two conversions
 * that bridge it are the only place in the file where a decimal exists.
 *
 * Values are always clamped to [min, min(max, balance)] client-side; the
 * server re-validates every bet regardless.
 */
export function createBetControl({ container, min, max, getBalance }) {
  // `0.07 * 100` is 7.000000000000001, and an integer is what the server
  // will accept, so the trip back through a decimal always rounds.
  const toCredits = (units) => (units / CREDIT).toFixed(2);
  const toUnits = (credits) => Math.round(Number(credits) * CREDIT);

  const input = el('input', {
    cls: 'num',
    attrs: {
      type: 'number',
      min: toCredits(min),
      max: toCredits(max),
      // The finest amount that exists. A typed 0.05 is a real stake, not
      // a rounding error to be pushed up to the nearest whole credit.
      step: '0.01',
      value: toCredits(min),
    },
  });

  const clamp = () => {
    let v = toUnits(input.value);
    if (!Number.isFinite(v)) v = min;
    const cap = Math.max(min, Math.min(max, getBalance()));
    input.value = toCredits(Math.min(Math.max(v, min), cap));
  };

  // The buttons move by whole credits, which is the size of a decision
  // rather than the size of the unit — a stepper that walked a hundredth
  // at a time would take a hundred presses to raise a bet by one. Below
  // a credit they fall back to the minimum so the smallest stakes are
  // still reachable without typing.
  const stride = Math.max(min, CREDIT);
  const step = (dir) => {
    const from = toUnits(input.value) || min;
    input.value = toCredits(from + dir * stride);
    clamp();
  };

  const label = el('label', { dataT: 'bet_label' });
  const stepper = el('div', { cls: 'bet-stepper' }, [
    el('button', { cls: 'btn ghost', text: '−', attrs: { type: 'button' }, on: { click: () => step(-1) } }),
    input,
    el('button', { cls: 'btn ghost', text: '+', attrs: { type: 'button' }, on: { click: () => step(1) } }),
    el('button', {
      cls: 'btn ghost', dataT: 'btn_max', attrs: { type: 'button' },
      on: { click: () => { input.value = toCredits(max); clamp(); } },
    }),
  ]);

  // Written in credits because that is what they are labelled with. The
  // smallest is a tenth, so micro-stakes are one tap away rather than
  // something you have to know to type.
  const chips = el('div', { cls: 'chip-row' });
  for (const credits of [0.1, 1, 5, 25, 100, 500]) {
    const value = Math.round(credits * CREDIT);
    if (value < min || value > max) continue;
    chips.append(
      el('button', {
        cls: 'chip', text: String(credits), attrs: { type: 'button' },
        on: { click: () => { input.value = toCredits(value); clamp(); } },
      }),
    );
  }

  input.addEventListener('change', clamp);
  container.append(label, stepper, chips);
  clamp();

  return {
    get value() {
      clamp();
      return toUnits(input.value);
    },
    setDisabled(disabled) {
      for (const b of [...stepper.querySelectorAll('button'), ...chips.querySelectorAll('button')]) {
        b.disabled = disabled;
      }
      input.disabled = disabled;
    },
  };
}
