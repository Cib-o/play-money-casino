import { el, state } from './shell.js';

/**
 * Shared bet control: − / + steppers, quick-bet chips and MAX.
 * Values are always clamped to [min, min(max, balance)] client-side;
 * the server re-validates every bet regardless.
 */
export function createBetControl({ container, min, max, getBalance }) {
  const input = el('input', {
    cls: 'num',
    attrs: { type: 'number', min: String(min), max: String(max), step: '1', value: String(min) },
  });

  const clamp = () => {
    let v = Math.floor(Number(input.value));
    if (!Number.isFinite(v)) v = min;
    const cap = Math.max(min, Math.min(max, getBalance()));
    input.value = String(Math.min(Math.max(v, min), cap));
  };

  const step = (dir) => {
    input.value = String(Math.floor(Number(input.value) || min) + dir);
    clamp();
  };

  const label = el('label', { dataT: 'bet_label' });
  const stepper = el('div', { cls: 'bet-stepper' }, [
    el('button', { cls: 'btn ghost', text: '−', attrs: { type: 'button' }, on: { click: () => step(-1) } }),
    input,
    el('button', { cls: 'btn ghost', text: '+', attrs: { type: 'button' }, on: { click: () => step(1) } }),
    el('button', {
      cls: 'btn ghost', dataT: 'btn_max', attrs: { type: 'button' },
      on: { click: () => { input.value = String(max); clamp(); } },
    }),
  ]);

  const chips = el('div', { cls: 'chip-row' });
  for (const value of [1, 5, 25, 100, 500].filter((v) => v >= min && v <= max)) {
    chips.append(
      el('button', {
        cls: 'chip', text: String(value), attrs: { type: 'button' },
        on: { click: () => { input.value = String(value); clamp(); } },
      }),
    );
  }

  input.addEventListener('change', clamp);
  container.append(label, stepper, chips);
  clamp();

  return {
    get value() {
      clamp();
      return Number(input.value);
    },
    setDisabled(disabled) {
      for (const b of [...stepper.querySelectorAll('button'), ...chips.querySelectorAll('button')]) {
        b.disabled = disabled;
      }
      input.disabled = disabled;
    },
  };
}
