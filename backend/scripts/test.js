// Rule tests: node scripts/test.js
import assert from 'node:assert/strict';
import { addr, ledger, fakeTx } from './fake.js';

const MINT = addr(), DEV = addr(), POOL_OWNER = addr();
Object.assign(process.env, {
  RPC_URL: 'http://localhost:0', MINT, DEV_WALLET: DEV, POOL_OWNERS: POOL_OWNER,
  DB_PATH: ':memory:', MIN_INFECT: '1000', VAX_BURN: '25000', MIN_ACTIVE_HOLD: '1000',
  EPOCH_START: '2026-01-01T00:00:00Z', NAMES: '0',
});
const { cfg } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { makeApplier } = await import('../src/infect.js');
const { mintDeltas } = await import('../src/parse.js');
const { buildSnapshot } = await import('../src/graph.js');

const db = openDb(cfg);
const apply = makeApplier(db, cfg);
const L = ledger(MINT);
const now = Math.floor(Date.now() / 1000) - 600;
const run = (tx) => apply(mintDeltas(tx, MINT));
const w = (a) => db.prepare('SELECT * FROM wallets WHERE address=?').get(a);

// dev seeds pool
L.bal.set(DEV, 1e9);
run(L.move(now, [{ owner: DEV, delta: -8e8 }, { owner: POOL_OWNER, delta: 8e8 }]));
assert.equal(w(POOL_OWNER), undefined, 'pool owner is not a wallet');

// A buys from pool -> infected by pool
const A = addr(), B = addr(), C = addr(), D = addr(), E = addr(), X = addr(), Y = addr();
run(L.move(now + 1, [{ owner: POOL_OWNER, delta: -500000 }, { owner: A, delta: 500000 }]));
assert.equal(w(A).parent, 'pool'); assert.equal(w(A).via, 'buy'); assert.equal(w(A).gen, 2);

// A sends 2000 to B -> B infected by A
run(L.move(now + 2, [{ owner: A, delta: -2000 }, { owner: B, delta: 2000 }]));
assert.equal(w(B).parent, A); assert.equal(w(B).gen, 3);

// B sends 500 to C -> below MIN_INFECT, not infected
run(L.move(now + 3, [{ owner: B, delta: -500 }, { owner: C, delta: 500 }]));
assert.equal(w(C).infected_at, null); assert.equal(w(C).balance, 500);

// C (uninfected holder) sends to D -> D not infected
run(L.move(now + 4, [{ owner: C, delta: -500 }, { owner: D, delta: 500 }]));
assert.equal(w(D).infected_at, null);

// airdrop from A to D and E in one tx -> both infected by A
run(L.move(now + 5, [{ owner: A, delta: -10000 }, { owner: D, delta: 5000 }, { owner: E, delta: 5000 }]));
assert.equal(w(D).parent, A); assert.equal(w(E).parent, A);

// first infection sticks: B sends to D, D keeps A as parent
run(L.move(now + 6, [{ owner: B, delta: -1200 }, { owner: D, delta: 1200 }]));
assert.equal(w(D).parent, A);

// duplicate signature is ignored
const tx = L.move(now + 7, [{ owner: A, delta: -3000 }, { owner: X, delta: 3000 }]);
run(tx); const before = w(A).balance; run(tx);
assert.equal(w(A).balance, before); assert.equal(w(X).parent, A);

// A burns 25k in two burns -> vaccinated on the second
run(L.move(now + 8, [{ owner: A, delta: -10000 }]));
assert.equal(w(A).vaccinated_at, null);
run(L.move(now + 9, [{ owner: A, delta: -15000 }]));
assert.equal(w(A).vaccinated_at, now + 9); assert.equal(w(A).burned, 25000);

// vaccinated A can no longer infect
run(L.move(now + 10, [{ owner: A, delta: -5000 }, { owner: Y, delta: 5000 }]));
assert.equal(w(Y).infected_at, null);

// failed transaction is ignored
run(fakeTx({ mint: MINT, t: now + 11, err: { InstructionError: [0, 'x'] }, changes: [{ owner: POOL_OWNER, pre: 1, post: 0 }, { owner: Y, pre: 5000, post: 6000 }] }));
assert.equal(w(Y).infected_at, null);

// a sell (wallet -> pool) does not infect the pool owner or anyone
run(L.move(now + 12, [{ owner: B, delta: -100 }, { owner: POOL_OWNER, delta: 100 }]));
assert.equal(w(POOL_OWNER), undefined);

const s = buildSnapshot(db, cfg);
const node = (a) => s.nodes.find((n) => n[0] === a);
assert.equal(s.nodes[0][0], DEV); assert.equal(s.nodes[1][0], 'pool');
assert.equal(node(A)[9], 4, 'A has B, D, E, X downstream');
// score only counts descendants still holding >= 1000: B dropped to 200, so D, E, X count
assert.equal(node(A)[10], 3);
assert.equal(s.stats.vaccinated, 1);
assert.equal(s.leaders.length >= 1, true); assert.equal(s.nodes[s.leaders[0]][0], A);
console.log('All infection rule tests passed ✔');
console.log(`snapshot: ${s.nodes.length} nodes, feed ${s.feed.length}, leaders ${s.leaders.length}`);
