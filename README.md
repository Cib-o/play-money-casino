# Play-Money Casino

A self-hosted casino **simulator** with an admin-managed credit balance.
One small Node.js process serves an admin dashboard and a bilingual
(ქართული / English) player app with provably fair games.

> **Credits are play points. They have no monetary value, cannot be
> bought, and cannot be cashed out.**
> კრედიტი სათამაშო ქულაა. მას ფულადი ღირებულება არ აქვს, არ იყიდება და
> არ განაღდდება.
>
> This boundary is structural, not cosmetic. The codebase contains **no
> payment integration, no deposits, no withdrawals, no transfers between
> users, and no record of real money anywhere**. A balance changes in
> exactly two ways: a game round resolves, or an administrator edits it
> in the dashboard — and every admin edit leaves an audit row. The same
> notice renders in the footer of every page, in the active language.
> If you fork this project, that is what you are forking.

There is no public sign-up. Accounts exist only because an administrator
created them and handed over the generated password.

## Stack

- Node.js 20+, ES modules, [Fastify](https://fastify.dev)
- SQLite (single file, WAL) via `better-sqlite3`
- Plain HTML/CSS/ES-module frontend — **no build step**
- Sessions: HMAC-SHA256-signed cookies; passwords: scrypt (`node:crypto`)

Five runtime dependencies, one process, one database file. A 1 vCPU /
1 GB VPS is plenty.

## Quick start (local)

```bash
git clone https://github.com/Cib-o/play-money-casino.git
cd play-money-casino
cp .env.example .env
# put a secret into .env:  SESSION_SECRET=<output of the next line>
openssl rand -hex 32
npm ci
npm run create-admin        # pick the first admin's credentials
npm start                   # http://127.0.0.1:3000
```

Optionally `npm run demo-data` creates demo players with generated
passwords printed once to the terminal.

## Production install (Ubuntu 22.04)

Copy-paste path; ~10 minutes.

```bash
# 1. Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. App user + code
sudo adduser --system --group --home /opt/play-money-casino casino
sudo -u casino git clone https://github.com/Cib-o/play-money-casino.git /opt/play-money-casino
cd /opt/play-money-casino

# 3. Configuration
sudo -u casino cp .env.example .env
openssl rand -hex 32        # copy the output
sudo -u casino nano .env    # paste it as SESSION_SECRET, set NODE_ENV=production

# 4. Install and bootstrap
sudo -u casino npm ci
sudo -u casino npm run create-admin

# 5. systemd
sudo cp deploy/play-money-casino.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now play-money-casino
systemctl status play-money-casino

# 6. nginx + TLS
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/play-money-casino
# edit server_name to your domain:
sudo nano /etc/nginx/sites-available/play-money-casino
sudo ln -s /etc/nginx/sites-available/play-money-casino /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.example
```

`NODE_ENV=production` (set in the systemd unit) marks the session cookie
`Secure`, so it only travels over HTTPS.

## Configuration

`.env` (see `.env.example` — every variable is documented there):

| Variable         | Default     | Meaning                                    |
|------------------|-------------|--------------------------------------------|
| `PORT`           | `3000`      | HTTP port                                   |
| `HOST`           | `127.0.0.1` | Bind address (keep local behind nginx)      |
| `SESSION_SECRET` | — required  | ≥ 32 chars; the server refuses to start without it |
| `NODE_ENV`       | —           | `production` ⇒ `Secure` cookies             |
| `DATA_DIR`       | `./data`    | Where `app.db` lives                        |

Everything else — RTP (0.80–0.99), min/max bet, default starting
balance, platform name, per-game on/off — is edited live in
**/admin/settings** and stored in the database.

## Admin dashboard

- **Create player** — username plus defaults, one click; the generated
  password (`quartz-fjord-cedar-37` style) is shown once, next to a
  Copy button that produces a paste-ready block with the login URL, in
  the player's language. The whole flow takes seconds.
- **Edit balance** — `Set to` and `Add / subtract` side by side; typing
  in one clears the other. Every change writes a `balance_adjustments`
  row (before, after, delta, note, which admin) and the dialog shows
  the player's last ten. Balances can never go below zero.
- **Players list** — search, round counts, reset password,
  disable/enable (disabling kills the player's session immediately).
- **Audit log** — every balance change across every player, newest
  first.

## Fairness

All outcomes are computed **server-side** from `node:crypto` primitives
under a commit–reveal scheme; `Math.random()` is not used anywhere.

1. The server generates a 32-byte `server_seed` and publishes only
   `sha256(server_seed)` — visible on the **Fairness** page before you
   play.
2. You may set your own `client_seed`.
3. Round *n* draws bytes from
   `HMAC-SHA256(server_seed, "clientSeed:nonce:cursor")`; the first six
   bytes over 2⁴⁸ give a uniform float in [0, 1).
4. Rotating the seed **reveals** the old `server_seed` and stamps it
   onto every round played under it.

**/verify** then recomputes any revealed round entirely in the browser
with WebCrypto — no server round-trip — and compares against the
recorded outcome. The test suite runs the same browser module under
Node and asserts it matches the server implementation exactly.

### RTP

Slot multipliers are fixed; only the **frequency** of wins is
calibrated so the expected return equals the configured RTP exactly
(at RTP 0.96 the hit rate is ≈27.6%). The test suite proves the
theoretical return to within 1e-12 at RTP 0.90 / 0.96 / 0.98 and runs
2,000,000 rounds against a four-standard-error band.

There is deliberately no near-miss engineering, no
losses-disguised-as-wins, no jackpots, streaks, levels or win jingles.
A win is displayed as a number.

## Games

### Slots
Three reels, one line, multipliers 0.5×–2000×. The outcome (a
multiplier) is decided first from the calibrated table; reels are then
chosen to display it — a losing round can never render as three of a
kind.

## Backup

```bash
scripts/backup.sh            # writes backups/app-YYYYmmdd-HHMMSS.db
```

Uses SQLite's `VACUUM INTO`, which is safe while the server is
running. Cron example: `17 3 * * * /opt/play-money-casino/scripts/backup.sh`.

## Tests

```bash
npm test
```

Covers RNG determinism and uniformity, RTP calibration (exact and
empirical), display-mapping invariants, the browser-verifier mirror,
i18n key parity, and the HTTP surface (auth, role guards, bet
validation, audit trail, atomic settlement, seed rotation).

## Project structure

```
server.js            entry point
src/                 config, db, auth, rng, seeds, games/, routes/
public/              static frontend (no build step)
scripts/             create-admin, demo-data, backup, i18n tooling
deploy/              systemd unit + nginx example
test/                node:test suite
```

## License

[MIT](LICENSE)
