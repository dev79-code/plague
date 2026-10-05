import 'dotenv/config';

const list = (k) => (process.env[k] || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const req = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var ${k}. Copy .env.example to .env and fill it in.`);
  return v;
};

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PE9ZpLHP7S4EFp';

export const cfg = {
  port: num('PORT', 8080),
  rpcUrl: req('RPC_URL'),
  mint: req('MINT'),
  devWallet: req('DEV_WALLET'),
  // Owners of the pool token vaults (bonding curve + DAMM v2 after graduation). Tokens leaving these = a buy.
  poolOwners: list('POOL_OWNERS'),
  // Extra addresses whose transaction history is polled (e.g. the pool addresses). The mint is always polled.
  extraWatch: list('EXTRA_WATCH'),
  tokenProgram: (process.env.TOKEN_PROGRAM || 'spl') === 'token2022' ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
  prizeWallet: process.env.PRIZE_WALLET || '',
  prizeReserveSol: num('PRIZE_RESERVE_SOL', 0.05),

  minInfect: num('MIN_INFECT', 1000),        // tokens a wallet must receive to be infected
  minActiveHold: num('MIN_ACTIVE_HOLD', 1000), // descendants must still hold this much to count for score
  vaxBurn: num('VAX_BURN', 25000),           // cumulative burn needed to be vaccinated

  epochStart: Math.floor(Date.parse(process.env.EPOCH_START || '2026-10-01T00:00:00Z') / 1000),
  epochHours: num('EPOCH_HOURS', 24),
  split: {
    spreader: num('SPLIT_SPREADER', 0.5),
    deepest: num('SPLIT_DEEPEST', 0.25),
    cure: num('SPLIT_CURE', 0.25),
  },

  dbPath: process.env.DB_PATH || './data/plague.db',
  worker: process.env.WORKER !== '0',
  pollMs: num('POLL_MS', 4000),
  reconcileMs: num('RECONCILE_MS', 10 * 60 * 1000),
  statsMs: num('STATS_MS', 60 * 1000),
  snapshotMs: num('SNAPSHOT_MS', 3000),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  corsOrigins: list('CORS_ORIGINS'),
  namesEnabled: process.env.NAMES !== '0',
};

export function epochOf(t) {
  const len = cfg.epochHours * 3600;
  const id = Math.floor((t - cfg.epochStart) / len);
  return { id, start: cfg.epochStart + id * len, end: cfg.epochStart + (id + 1) * len };
}
