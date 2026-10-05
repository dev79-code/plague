// Runs the API with a fake, continuously spreading outbreak so you can try the
// frontend before the token exists. No RPC needed.
//
//   npm run demo        then open the frontend with ?api=http://localhost:8080
import { addr, ledger } from './fake.js';

const MINT = 'PLAGUEdemo1111111111111111111111111111111111';
const DEV = addr(), POOL_OWNER = addr();
Object.assign(process.env, {
  RPC_URL: 'http://127.0.0.1:1', MINT, DEV_WALLET: DEV, POOL_OWNERS: POOL_OWNER,
  DB_PATH: process.env.DEMO_DB || ':memory:', WORKER: '0', NAMES: '0', SNAPSHOT_MS: '1500',
  EPOCH_START: new Date(Date.now() - 9 * 3600e3).toISOString(),
});
const { cfg } = await import('../src/config.js');
const { openDb, kv } = await import('../src/db.js');
const { makeApplier } = await import('../src/infect.js');
const { mintDeltas } = await import('../src/parse.js');

// In-memory DBs are per connection, so the demo writes through the server's own module instance.
if (cfg.dbPath === ':memory:') { process.env.DB_PATH = './data/demo.db'; cfg.dbPath = './data/demo.db'; }
const fs = await import('node:fs');
for (const f of ['', '-wal', '-shm']) fs.rmSync(cfg.dbPath + f, { force: true });

const db = openDb(cfg);
const apply = makeApplier(db, cfg);
const L = ledger(MINT);
const names = ['degenrat', 'moonfarmer', 'toxicnurse', 'gigaape', 'nightmonk', 'ferallord', 'sleepywhale', 'frogdoctor', 'rugwizard', 'alphaghoul'];
const named = db.prepare('UPDATE wallets SET name=? WHERE address=?');

L.bal.set(DEV, 1e9);
let t = Math.floor(Date.now() / 1000) - 6 * 3600;
apply(mintDeltas(L.move(t, [{ owner: DEV, delta: -7.8e8 }, { owner: POOL_OWNER, delta: 7.8e8 }]), MINT));
const infected = [DEV];

function tick(dt) {
  t += dt;
  const r = Math.random();
  if (r < 0.05 && infected.length > 20) {
    const v = infected[1 + Math.floor(Math.random() * (infected.length - 1))];
    if (L.get(v) > 30000) { apply(mintDeltas(L.move(t, [{ owner: v, delta: -25000 - Math.round(Math.random() * 30000) }]), MINT)); return; }
  }
  const to = addr();
  if (r < 0.32 || infected.length < 4) {
    const amt = Math.round(Math.exp(Math.log(20000) + Math.random() * Math.log(400))); // 20k .. 8M
    apply(mintDeltas(L.move(t, [{ owner: POOL_OWNER, delta: -amt }, { owner: to, delta: amt }]), MINT));
  } else {
    const recent = infected.slice(-60);
    const from = Math.random() < 0.6 ? recent[Math.floor(Math.random() * recent.length)] : infected[Math.floor(Math.random() * infected.length)];
    const amt = Math.max(1000, Math.round(L.get(from) * (0.05 + Math.random() * 0.3)));
    if (L.get(from) < amt) return;
    apply(mintDeltas(L.move(t, [{ owner: from, delta: -amt }, { owner: to, delta: amt }]), MINT));
  }
  if (db.prepare('SELECT infected_at FROM wallets WHERE address=?').get(to)?.infected_at != null) {
    infected.push(to);
    if (Math.random() < 0.18) named.run(`${names[Math.floor(Math.random() * names.length)]}${Math.floor(Math.random() * 99)}.sol`, to);
  }
}
for (let i = 0; i < 260; i++) tick(60 + Math.round(Math.random() * 30));
t = Math.floor(Date.now() / 1000) - 60;
const k = kv(db);
k.set('supply', 1e9); k.set('prize_lamports', 18.42e9); k.set('price_sol', 2.1e-6); k.set('holders', infected.length);

await import('../src/server.js');
setInterval(() => {
  tick(Math.max(1, Math.floor(Date.now() / 1000) - t));
  const p = k.get('prize_lamports'); k.set('prize_lamports', p + Math.round(Math.random() * 3e7));
}, 1500);
console.log('[demo] fake outbreak running. Frontend: open index.html?api=http://localhost:' + cfg.port);
