# $PLAGUE outbreak map

```
frontend/   static site for Vercel (index.html + vercel.json)
backend/    indexer + API for a DigitalOcean droplet (Node 22, SQLite, Docker, Caddy for HTTPS)
```

How it works: the backend follows every $PLAGUE transaction on Solana, applies the infection rules, and stores the
lineage in SQLite. The frontend loads `/api/graph` every 5 seconds and draws the map. Vercel forwards `/api/*` to
your droplet, so the browser never talks to the droplet directly.

```
Solana RPC (Helius) ──► backend poller ──► SQLite ──► /api/graph ──► Vercel rewrite ──► browser
                       (+ optional Helius webhook)
```

---

## 1. Try it locally first (no token needed)

```bash
cd backend
npm install
npm test          # infection rule tests
npm run demo      # API on :8080 with a fake outbreak that keeps spreading
```

Open `frontend/index.html?api=http://localhost:8080` in your browser.

## 2. Launch the token on Meteora

1. Launch $PLAGUE from your **dev wallet** (this is patient zero). Note the **mint address**.
2. Create a separate **prize wallet**: `solana-keygen new -o prize-keypair.json`. Its address is `PRIZE_WALLET`.
3. Get a Helius API key (helius.dev). Free tier is fine for testing; use a paid plan at launch because every
   transaction is fetched.

## 3. Hand the creator fees to the prize wallet

The server claims your Meteora creator fees and sends them to the prize wallet. Claiming must be signed by the
pool's creator, and you don't want your dev wallet key on a server. So, once, on **your own computer**, move the
creator role to the prize wallet:

```bash
cd backend && npm install
cp .env.example .env    # set RPC_URL, MINT, DEV_WALLET, PRIZE_WALLET
DEV_KEYPAIR=~/path/to/dev-keypair.json node scripts/transfer-creator.js            # preview
DEV_KEYPAIR=~/path/to/dev-keypair.json node scripts/transfer-creator.js --execute  # do it
```

This works while the token is on the bonding curve. If it has already graduated to DAMM v2, send the LP position
NFT from your dev wallet to the prize wallet in your wallet app instead (it shows up as an NFT).

Pool detection needs no setup: every Meteora bonding-curve and DAMM v2 vault is owned by one of two fixed
addresses, which are the default for `POOL_OWNERS`.

## 4. Backend on a droplet

1. Create an Ubuntu 24.04 droplet (the $6–12/month size is enough to start).
2. Add a DNS **A record**: `api.yourdomain.com` → droplet IP.
3. Copy the `backend` folder to the droplet (`scp -r backend root@IP:/opt/plague` or push to GitHub and clone).
4. On the droplet:

```bash
cd /opt/plague
bash deploy/setup-droplet.sh        # installs Docker, opens ports 22/80/443
cp .env.example .env && nano .env   # fill in RPC_URL, MINT, DEV_WALLET, PRIZE_WALLET, API_DOMAIN, CORS_ORIGINS
mkdir -p secrets && nano secrets/prize-keypair.json   # paste the prize keypair (needed for fee claims and payouts)
docker compose up -d --build
docker compose logs -f api          # watch it backfill
curl https://api.yourdomain.com/api/health
```

Start the backend before or right after launch. If it starts later, it backfills everything from the mint's first
transaction anyway.

Useful commands:

```bash
docker compose up -d                                # after editing .env (restart does not reload it)
docker compose up -d --build                       # after updating code
sqlite3 data/plague.db ".backup data/backup.db"    # back up (add to a daily cron)
```

## 5. Frontend on Vercel

1. In `frontend/vercel.json`, replace `api.yourdomain.com` with your API domain.
2. Deploy the `frontend` folder: `cd frontend && npx vercel --prod`, or import the repo in Vercel with
   **Root Directory = frontend** and **Framework = Other**.
3. Put your Vercel URL in `CORS_ORIGINS` in the droplet's `.env` and restart the api (only needed if the site calls
   the API directly with `?api=`; the rewrite doesn't need CORS).

## 6. Optional: Helius webhook (faster updates)

The poller checks the chain every 4 seconds, which is enough. For near-instant updates, also add a webhook in the
Helius dashboard:

- Type: **raw**, network mainnet
- Account address: your **mint**
- URL: `https://api.yourdomain.com/webhook/helius`
- Auth header: the same value as `WEBHOOK_SECRET` in `.env`

The poller and webhook can run together. Each transaction is only counted once.

## 7. Fee claiming

With `FEE_CLAIM_HOURS=6` the server claims every 6 hours: bonding-curve creator fees while the token is on the curve,
and DAMM v2 LP position fees after graduation. Everything goes to the prize wallet, and claims smaller than
`MIN_CLAIM_QUOTE` SOL are skipped so network fees don't eat them. Set `FEE_CLAIM_HOURS=0` to turn it off.

By hand:

```bash
docker compose exec api node scripts/claim-fees.js            # shows what's claimable
docker compose exec api node scripts/claim-fees.js --execute  # claims it
```

Claims are listed at `/api/fees`, and the map shows the total claimed. If the claim key isn't the pool creator,
the log says so and nothing is sent. Any $PLAGUE fees also land in the prize wallet; the prize wallet is never
counted as infected.

## 8. Paying prizes

After an epoch ends:

```bash
docker compose exec api node scripts/payout.js             # dry run: shows winners and amounts
mkdir -p secrets && cp prize-keypair.json secrets/         # only on the droplet, never in git
docker compose exec api node scripts/payout.js --execute   # sends SOL from the prize wallet
docker compose exec api node scripts/payout.js --epoch 3   # a specific epoch
```

If a category has no winner (for example nobody got vaccinated), its share stays in the prize wallet and rolls
into the next epoch. An epoch is never paid twice. Payouts are recorded and visible at `/api/payouts`. Review the dry run every time
before you run `--execute`.

---

## Rules as implemented

| Rule | Where | Setting |
|---|---|---|
| Tokens leaving any Meteora bonding-curve or DAMM v2 vault infect the receiver (parent = pool) | `src/infect.js` | `POOL_OWNERS` (optional) |
| Receiving ≥ MIN_INFECT from an infected wallet infects you (parent = sender) | `src/infect.js` | `MIN_INFECT` |
| First infection is permanent; vaccinated and uninfected holders don't spread | `src/infect.js` | — |
| Burning VAX_BURN in total vaccinates you | `src/infect.js` | `VAX_BURN` |
| Epoch score = descendants infected this epoch, still holding MIN_ACTIVE_HOLD, before you were vaccinated | `src/graph.js` | `MIN_ACTIVE_HOLD` |
| Prize split: top score / deepest generation this epoch / burners this epoch by amount | `src/graph.js`, `scripts/payout.js` | `SPLIT_*` |

Transfers are read from each transaction's before/after token balances, so Jupiter routes, multi-hop swaps and
airdrop tools all resolve to "who lost tokens, who gained them". When one wallet sends to many in one transaction,
all receivers are infected by it. Every 10 minutes, balances are corrected from the chain.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/graph` | Full snapshot: nodes, stats, leaders, feed, prize, epidemic curve |
| `GET /api/wallet/:address` | Status of any wallet (infected / vaccinated / holder / clean) |
| `GET /api/payouts` | Payout history |
| `GET /api/fees` | Fee claim history |
| `GET /api/health` | Health check |
| `POST /webhook/helius` | Helius raw webhook receiver |

## Things to decide before launch

- **Fake-wallet farming.** Someone can split tokens across many new wallets to inflate their score. The
  MIN_INFECT and MIN_ACTIVE_HOLD settings make that cost real money. Raise them so they're worth a few dollars each,
  and watch the leaderboard before paying.
- **Rare missed transfers.** A transfer made with the old SPL `transfer` instruction doesn't mention the mint, so the
  poller can miss it as an infection (balances still get corrected). Wallets and Meteora use `transferChecked`, so
  this is uncommon. The Helius webhook doesn't fix it either.
- **Very large outbreaks.** The map stays smooth up to a few thousand wallets and lightens its effects above 4,000.
  Past roughly 20k infected wallets, consider showing only the top branches.
- **Legal.** Paying prizes for activity around a token can count as a lottery or promotion in some places. Get advice
  for where you and your players are.
