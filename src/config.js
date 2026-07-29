import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env parser. KEY=VALUE lines, # comments, optional quotes.
 * Values already present in process.env win, so systemd Environment=
 * and shell overrides behave as expected.
 */
export function loadEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

/**
 * Resolve runtime configuration. The session secret is mandatory for
 * the server but not for CLI scripts (create-admin runs before any
 * secret exists), hence the flag.
 */
export function getConfig({ requireSecret = true } = {}) {
  loadEnv();
  const sessionSecret = process.env.SESSION_SECRET || '';
  if (requireSecret && sessionSecret.length < 32) {
    throw new Error(
      'SESSION_SECRET is required and must be at least 32 characters. ' +
        'Generate one with: openssl rand -hex 32 — then put it in .env',
    );
  }
  return {
    root: ROOT,
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '127.0.0.1',
    dataDir: path.resolve(ROOT, process.env.DATA_DIR || './data'),
    dbPath: path.join(path.resolve(ROOT, process.env.DATA_DIR || './data'), 'app.db'),
    sessionSecret,
    production: process.env.NODE_ENV === 'production',
  };
}
