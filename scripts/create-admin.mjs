#!/usr/bin/env node
// Creates the first administrator account. This is the only way an
// account comes into existence outside the admin dashboard — there are
// no default credentials anywhere in this repository.
//
//   npm run create-admin
//   npm run create-admin -- --username boss --password 'long secret here'

import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../src/config.js';
import { openDb, nowISO, readSettings } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--username') out.username = argv[++i];
    else if (argv[i] === '--password') out.password = argv[++i];
  }
  return out;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let username = args.username;
  while (!username || !USERNAME_RE.test(username)) {
    if (username) console.error('Username must be 3-32 characters: letters, digits, _ . -');
    username = (await rl.question('Admin username: ')).trim();
  }
  username = username.toLowerCase();

  let password = args.password;
  while (!password || password.length < 8) {
    if (password) console.error('Password must be at least 8 characters.');
    password = await rl.question('Admin password (min 8 chars, input is visible): ');
  }
  rl.close();

  // The session secret is not needed to bootstrap an admin, so this can
  // be the very first command run after npm ci.
  const config = getConfig({ requireSecret: false });
  const db = openDb(config.dbPath);

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    console.error(`User "${username}" already exists. Nothing changed.`);
    process.exit(1);
  }

  const { defaultLocale } = readSettings(db);
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, balance, locale, is_active, created_at, created_by)
     VALUES (?, ?, ?, ?, 'admin', 0, ?, 1, ?, NULL)`,
  ).run(randomUUID(), username, username, hashPassword(password), defaultLocale, nowISO());

  console.log('');
  console.log(`Admin "${username}" created.`);
  console.log('Start the server with: npm start');
  console.log('Then sign in at /login and open /admin.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
