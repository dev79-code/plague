import express from 'express';
import compression from 'compression';
import cors from 'cors';
import zlib from 'node:zlib';
import { cfg } from './config.js';
import { openDb } from './db.js';
import { makeRpc } from './rpc.js';
import { mintDeltas } from './parse.js';
import { makeApplier } from './infect.js';
import { makePoller } from './poller.js';
import { makeChainJobs } from './chain.js';
import { buildSnapshot, walletInfo } from './graph.js';

const db = openDb(cfg);
const apply = makeApplier(db, cfg);
const rpc = makeRpc(cfg.rpcUrl);

/* ---------- snapshot cache ---------- */
let dirty = true, cache = null, cacheGz = null, building = false;
const markDirty = () => { dirty = true; };
function snapshot() {
  if ((dirty || !cache) && !building) {
    building = true;
    try {
      const json = JSON.stringify(buildSnapshot(db, cfg));
      cache = json;
      cacheGz = zlib.gzipSync(json);
      dirty = false;
    } finally { building = false; }
  }
  return cache;
}
// Notice writes from any process (payout script, demo generator) by watching the row counters.
const revQ = db.prepare(`SELECT (SELECT COALESCE(MAX(rowid),0) FROM processed) || ':' || (SELECT COALESCE(MAX(id),0) FROM events) || ':' || (SELECT COALESCE(SUM(v IS NOT NULL),0) FROM kv)`).pluck();
let lastRev = '';
setInterval(() => {
  const rev = revQ.get();
  if (rev !== lastRev) { lastRev = rev; dirty = true; }
  if (dirty) snapshot();
}, cfg.snapshotMs);
setInterval(markDirty, 30_000); // keeps epoch clock / curve fresh even when quiet

/* ---------- http ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: cfg.corsOrigins.length ? cfg.corsOrigins : true }));

app.get('/api/health', (_req, res) => res.json({ ok: true, worker: cfg.worker, mint: cfg.mint }));

app.get('/api/graph', (req, res) => {
  snapshot();
  res.set('Cache-Control', 'public, max-age=3, s-maxage=3');
  res.type('application/json');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip').set('Vary', 'Accept-Encoding').send(cacheGz);
  } else res.send(cache);
});

app.use(compression());

app.get('/api/wallet/:address', (req, res) => {
  const a = String(req.params.address).trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return res.status(400).json({ error: 'That is not a Solana address.' });
  res.json(walletInfo(db, cfg, a));
});

app.get('/api/payouts', (_req, res) => {
  res.json(db.prepare('SELECT epoch, category, address, lamports, sig, status, created_at FROM payouts ORDER BY id DESC LIMIT 200').all());
});

// Optional: Helius "raw" webhook pointed at https://your-api/webhook/helius (lower latency than polling).
app.post('/webhook/helius', express.json({ limit: '25mb' }), (req, res) => {
  if (cfg.webhookSecret && req.get('authorization') !== cfg.webhookSecret) return res.status(401).end();
  const txs = Array.isArray(req.body) ? req.body : [req.body];
  let changes = 0;
  for (const tx of txs) {
    try { changes += apply(mintDeltas(tx, cfg.mint))?.changes || 0; } catch (e) { console.error('[webhook]', e.message); }
  }
  if (changes) markDirty();
  res.json({ ok: true, changes });
});

app.listen(cfg.port, () => console.log(`[api] listening on :${cfg.port} (worker ${cfg.worker ? 'on' : 'off'})`));

/* ---------- background worker ---------- */
if (cfg.worker) {
  const poller = makePoller({ rpc, db, cfg, apply, onChange: markDirty });
  const jobs = makeChainJobs({ rpc, db, cfg, onChange: markDirty });
  poller.loop();
  const every = (fn, ms, delay = 0) => setTimeout(function run() {
    fn().catch((e) => console.error('[job]', e.message)).finally(() => setTimeout(run, ms));
  }, delay);
  every(jobs.refreshStats, cfg.statsMs, 1000);
  every(jobs.reconcileBalances, cfg.reconcileMs, 20_000);
  every(jobs.resolveNames, 60_000, 30_000);
}

process.on('SIGTERM', () => { db.close(); process.exit(0); });
