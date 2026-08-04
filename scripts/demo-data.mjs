#!/usr/bin/env node
// Local-testing helper: creates an admin (if none exists) and a few
// players, all with freshly generated passwords printed once to the
// terminal. Nothing here is a default credential — every run invents
// new ones, and the script has no place in a production install.
//
//   npm run demo-data

import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { openDb, nowISO, readSettings, CREDIT } from '../src/db.js';
import { hashPassword, generatePassword } from '../src/auth.js';

const config = getConfig({ requireSecret: false });
const db = openDb(config.dbPath);
const settings = readSettings(db);

const insertUser = db.prepare(
  `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
);
const insertAdjustment = db.prepare(
  `INSERT INTO balance_adjustments (id, user_id, admin_id, "before", "after", delta, note, created_at)
   VALUES (?, ?, ?, 0, ?, ?, 'starting balance', ?)`,
);

let admin = db.prepare("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1").get();
const lines = [];

if (!admin) {
  const password = generatePassword();
  const id = randomUUID();
  insertUser.run(id, 'admin', 'admin', hashPassword(password), 'admin', 0, settings.defaultLocale, nowISO(), null);
  admin = { id, username: 'admin' };
  lines.push(`admin      ${password}   (role: admin)`);
}

// Balances are written in credits here and stored in hundredths, which
// is the one place in this script the distinction shows.
const demoPlayers = [
  { username: 'demo1', display: 'გიორგი', balance: 1000 * CREDIT, locale: 'ka' },
  { username: 'demo2', display: 'ნინო', balance: 2500 * CREDIT, locale: 'ka' },
  { username: 'demo3', display: 'Alex', balance: 500 * CREDIT, locale: 'en' },
];

const createAll = db.transaction(() => {
  for (const p of demoPlayers) {
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(p.username);
    if (exists) {
      lines.push(`${p.username.padEnd(10)} (already exists — skipped)`);
      continue;
    }
    const password = generatePassword();
    const id = randomUUID();
    insertUser.run(id, p.username, p.display, hashPassword(password), 'player', p.balance, p.locale, nowISO(), admin.id);
    if (p.balance > 0) {
      insertAdjustment.run(randomUUID(), id, admin.id, p.balance, p.balance, nowISO());
    }
    lines.push(
      `${p.username.padEnd(10)} ${password}   (balance: ${p.balance / CREDIT}, ${p.locale})`,
    );
  }
});
createAll();

console.log('');
console.log('Demo accounts (passwords shown only now):');
console.log('');
for (const line of lines) console.log('  ' + line);
console.log('');
console.log(`Sign in at http://127.0.0.1:${config.port}/login after npm start.`);
