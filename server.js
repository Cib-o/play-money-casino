import { getConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';

let config;
try {
  config = getConfig(); // refuses to start without a real SESSION_SECRET
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = openDb(config.dbPath);
const app = buildApp({ db, config, logger: true });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
