#!/usr/bin/env node
// Build-time Georgian copy pass over the UI string table. Sends each
// English source + current Georgian string to Gemini and asks for
// corrected, idiomatic Georgian in a consistent register, enforcing
// the project glossary. Never called at runtime.
//
//   node scripts/polish-georgian.mjs [--dry-run]
//
// The API key comes from a dotenv file that must never be committed:
// C:\Users\johna\.gemini.env by default, or the file named by the
// GEMINI_ENV_PATH environment variable (so the same script runs on a
// Linux box). The file must contain GEMINI_API_KEY=…

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRINGS_PATH = path.join(ROOT, 'public', 'js', 'strings.js');
const MODEL = 'gemini-2.5-flash';
const CHUNK_SIZE = 40;
const DRY_RUN = process.argv.includes('--dry-run');

// Keys whose wording is fixed by the project boundary and must never
// be rephrased (the test suite pins them verbatim).
const FROZEN = new Set(['footer_notice']);

const GLOSSARY =
  'balance=ბალანსი, credits=კრედიტი, bet=ფსონი, spin=ტრიალი, round=რაუნდი, ' +
  'payout=გასაცემი, dashboard=დეშბორდი, player=მოთამაშე, admin=ადმინისტრატორი, ' +
  'settings=პარამეტრები';

const INSTRUCTIONS = `You are a Georgian localisation editor for a casino-style web app.
For each key you receive the English source ("en") and the current Georgian translation ("ka").
Return corrected Georgian for every key:
- grammatically correct and idiomatic Georgian, not a literal calque of the English;
- consistent register: informal second person (შენ), sentence case;
- enforce this glossary exactly: ${GLOSSARY};
- keep roughly the same length class as the English source so the layout does not break;
- keep punctuation style (a trailing period only where the source has one) and keep symbols, numbers, × and · unchanged;
- if the current Georgian is already correct, return it unchanged.
Respond with JSON only: one object mapping every input key to the corrected Georgian string — every key exactly once, no extra keys, no commentary.`;

function loadApiKey() {
  const envPath = process.env.GEMINI_ENV_PATH || 'C:\\Users\\johna\\.gemini.env';
  if (!existsSync(envPath)) {
    console.error(`Gemini env file not found: ${envPath}`);
    console.error('Point GEMINI_ENV_PATH at a dotenv file containing GEMINI_API_KEY.');
    process.exit(1);
  }
  const vars = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[m[1]] = value;
  }
  if (!vars.GEMINI_API_KEY) {
    console.error(`No GEMINI_API_KEY in ${envPath}`);
    process.exit(1);
  }
  return vars.GEMINI_API_KEY;
}

async function callGemini(apiKey, chunk) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: INSTRUCTIONS }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(chunk, null, 1) }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
      return JSON.parse(text);
    }
    if (res.status === 429 || res.status >= 500) {
      const wait = attempt * 3000;
      console.error(`  Gemini ${res.status}; retrying in ${wait / 1000}s…`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
  }
  throw new Error('Gemini request failed after retries');
}

/** The returned key set must be IDENTICAL to what was sent. */
function validateChunk(sentKeys, received) {
  if (typeof received !== 'object' || received === null || Array.isArray(received)) {
    return 'response is not an object';
  }
  const got = Object.keys(received);
  if (got.length !== sentKeys.length) {
    return `key count mismatch: sent ${sentKeys.length}, got ${got.length}`;
  }
  for (const key of sentKeys) {
    if (!(key in received)) return `missing key: ${key}`;
    if (typeof received[key] !== 'string' || received[key].trim() === '') {
      return `empty or non-string value for: ${key}`;
    }
  }
  return null;
}

const { STRINGS } = await import(pathToFileURL(STRINGS_PATH).href);
const en = STRINGS.en;
const ka = STRINGS.ka;
const keys = Object.keys(en).filter((key) => !FROZEN.has(key));

const apiKey = loadApiKey();
const polished = {};

for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
  const slice = keys.slice(i, i + CHUNK_SIZE);
  const chunk = {};
  for (const key of slice) chunk[key] = { en: en[key], ka: ka[key] };
  console.error(`Polishing keys ${i + 1}–${i + slice.length} of ${keys.length}…`);
  const received = await callGemini(apiKey, chunk);
  const problem = validateChunk(slice, received);
  if (problem) {
    console.error(`Validation failed (${problem}) — nothing written.`);
    process.exit(1);
  }
  Object.assign(polished, received);
}

// Diff for human review before anything is committed.
let changed = 0;
for (const key of keys) {
  if (polished[key] !== ka[key]) {
    changed++;
    console.log(`${key}:`);
    console.log(`  - ${ka[key]}`);
    console.log(`  + ${polished[key]}`);
  }
}
console.log('');
console.log(`${changed} of ${keys.length} strings changed.`);

if (DRY_RUN || changed === 0) {
  if (DRY_RUN) console.log('Dry run — file not written.');
  process.exit(0);
}

const newKa = {};
for (const key of Object.keys(en)) {
  newKa[key] = FROZEN.has(key) ? ka[key] : polished[key];
}

const fileBody =
  '// Bilingual UI string table. Georgian is the default locale.\n' +
  '// Data only — scripts/polish-georgian.mjs regenerates this file, so\n' +
  '// keep logic out of it. Every user-facing string lives here; markup\n' +
  '// references keys via data-t (textContent) and data-tp (placeholder).\n' +
  'export const STRINGS = {\n' +
  `  en: ${JSON.stringify(en, null, 4).replace(/\n/g, '\n  ')},\n` +
  `  ka: ${JSON.stringify(newKa, null, 4).replace(/\n/g, '\n  ')}\n` +
  '};\n';

writeFileSync(STRINGS_PATH, fileBody);
console.log(`Wrote ${STRINGS_PATH} — review the diff above, then commit.`);
