// Builds the outbreak snapshot the map renders, and the per-epoch results the payout uses.
import { epochOf } from './config.js';
import { kv as kvStore } from './db.js';

const VIA = { launch: 0, liquidity: 1, buy: 2, transfer: 3 };

function loadGraph(db) {
  const rows = db.prepare(`SELECT address, parent, gen, via, infected_at, vaccinated_at, burned, balance, name
    FROM wallets WHERE infected_at IS NOT NULL ORDER BY infected_at, rowid`).all();
  const idx = new Map(rows.map((r, i) => [r.address, i]));
  const parentIdx = rows.map((r) => (r.parent != null && idx.has(r.parent) ? idx.get(r.parent) : -1));
  const children = rows.map(() => 0);
  const desc = rows.map(() => 0);
  for (let i = rows.length - 1; i >= 0; i--) {
    const p = parentIdx[i];
    if (p >= 0) { children[p]++; desc[p] += 1 + desc[i]; }
  }
  return { rows, idx, parentIdx, children, desc };
}

// Epoch scoring. A descendant counts for every ancestor if it was infected inside
// the epoch, still holds MIN_ACTIVE_HOLD, and the ancestor was not vaccinated yet.
export function computeEpoch(db, cfg, epoch, g = loadGraph(db)) {
  const { rows, parentIdx } = g;
  const score = rows.map(() => 0);
  let deepest = -1;
  const special = new Set([cfg.devWallet, 'pool']);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.infected_at < epoch.start || r.infected_at >= epoch.end || special.has(r.address)) continue;
    if (deepest < 0 || r.gen > rows[deepest].gen) deepest = i;
    if (r.balance < cfg.minActiveHold) continue;
    for (let a = parentIdx[i]; a >= 0; a = parentIdx[a]) {
      const anc = rows[a];
      if (anc.vaccinated_at == null || r.infected_at < anc.vaccinated_at) score[a]++;
    }
  }
  const leaders = rows.map((r, i) => i)
    .filter((i) => score[i] > 0 && !special.has(rows[i].address))
    .sort((a, b) => score[b] - score[a] || rows[a].infected_at - rows[b].infected_at)
    .slice(0, 10);

  const burns = db.prepare(`SELECT e.a AS address, SUM(e.amount) AS burned FROM events e
      JOIN wallets w ON w.address=e.a
      WHERE e.kind='burn' AND e.t>=? AND e.t<? AND w.vaccinated_at IS NOT NULL AND w.vaccinated_at < ?
      GROUP BY e.a ORDER BY burned DESC`).all(epoch.start, epoch.end, epoch.end);

  return { epoch, rows, score, leaders, deepest, cure: burns };
}

export function buildSnapshot(db, cfg) {
  const kv = kvStore(db);
  const now = Math.floor(Date.now() / 1000);
  const g = loadGraph(db);
  const { rows, idx, parentIdx, children, desc } = g;
  const epoch = epochOf(now);
  const ep = computeEpoch(db, cfg, epoch, g);

  const nodes = rows.map((r, i) => [
    r.address, parentIdx[i], r.gen ?? 0, r.vaccinated_at != null ? 1 : 0, VIA[r.via] ?? 3,
    Math.round(r.balance * 100) / 100, r.infected_at, Math.round(r.burned), r.name || null,
    desc[i], ep.score[i], children[i],
  ]);

  const wallets = rows.filter((r) => r.address !== 'pool' && r.address !== cfg.devWallet);
  const vaccinated = wallets.filter((r) => r.vaccinated_at != null).length;
  const older = rows.map((r, i) => i).filter((i) => rows[i].address !== 'pool' && now - rows[i].infected_at > 3600);
  const R = older.length ? older.reduce((s, i) => s + children[i], 0) / older.length : 0;
  const buys = wallets.filter((r) => r.via === 'buy').length;

  // epidemic curve: cumulative infections, hourly, last 72h
  const curve = [];
  const startH = Math.floor(now / 3600) * 3600 - 71 * 3600;
  let c = rows.filter((r) => r.infected_at < startH && r.infected_at > 0).length, k = 0;
  const sorted = wallets.map((r) => r.infected_at).sort((a, b) => a - b);
  while (k < sorted.length && sorted[k] < startH) k++;
  for (let h = 0; h < 72; h++) {
    const end = startH + (h + 1) * 3600;
    while (k < sorted.length && sorted[k] < end) { k++; c++; }
    curve.push(c);
  }

  const feed = db.prepare(`SELECT t, kind, a, b, amount FROM events WHERE kind IN ('buy','transfer','vax') ORDER BY id DESC LIMIT 40`).all()
    .map((e) => ({ t: e.t, k: e.kind, a: idx.get(e.a) ?? -1, b: e.b ? idx.get(e.b) ?? -1 : -1, n: Math.round(e.amount) }));

  const prizeSol = (kv.get('prize_lamports', 0) || 0) / 1e9;
  const pot = Math.max(0, prizeSol - cfg.prizeReserveSol);
  const curedBurn = ep.cure.reduce((s, r) => s + r.burned, 0);

  return {
    v: 1,
    updatedAt: now,
    mint: cfg.mint,
    supply: kv.get('supply', null),
    priceSol: kv.get('price_sol', null),
    rules: { minInfect: cfg.minInfect, vaxBurn: cfg.vaxBurn, minActiveHold: cfg.minActiveHold },
    epoch: { id: epoch.id, start: epoch.start, end: epoch.end },
    stats: {
      infected: rows.length - 1 - vaccinated, // everything except the pool node and vaccinated
      vaccinated,
      holders: kv.get('holders', null),
      R: Math.round(R * 100) / 100,
      deepestGen: rows.reduce((m, r) => Math.max(m, r.gen ?? 0), 0),
      poolPct: wallets.length ? Math.round((buys / wallets.length) * 100) : 0,
    },
    prize: {
      sol: Math.round(prizeSol * 1000) / 1000,
      pot: Math.round(pot * 1000) / 1000,
      split: cfg.split,
      cureWallets: ep.cure.length,
      cureBurned: Math.round(curedBurn),
    },
    leaders: ep.leaders,
    deepest: ep.deepest,
    curve,
    feed,
    // [address, parentIdx, gen, vaccinated, via, balance, infectedAt, burned, name, downstream, epochScore, directInfections]
    nodes,
  };
}

export function walletInfo(db, cfg, address) {
  const w = db.prepare('SELECT * FROM wallets WHERE address=?').get(address);
  if (!w) return { address, status: 'clean', balance: 0 };
  const status = w.infected_at == null ? (w.balance > 0 ? 'holder' : 'clean') : w.vaccinated_at != null ? 'vaccinated' : 'infected';
  return { address, status, balance: w.balance, parent: w.parent, gen: w.gen, via: w.via, infectedAt: w.infected_at, burned: w.burned, name: w.name };
}
