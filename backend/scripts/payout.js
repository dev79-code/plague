// Pays out an epoch's prizes from the prize wallet.
//
//   node scripts/payout.js                 dry run for the epoch that just ended
//   node scripts/payout.js --epoch 12      dry run for a specific epoch
//   node scripts/payout.js --execute       actually send SOL (needs PRIZE_KEYPAIR)
//
// Safe to re-run: an epoch that already has sent payouts is refused.
import fs from 'node:fs';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { cfg, epochOf } from '../src/config.js';
import { openDb } from '../src/db.js';
import { computeEpoch } from '../src/graph.js';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const ei = args.indexOf('--epoch');
const nowEpoch = epochOf(Math.floor(Date.now() / 1000));
const id = ei >= 0 ? Number(args[ei + 1]) : nowEpoch.id - 1;
const len = cfg.epochHours * 3600;
const epoch = { id, start: cfg.epochStart + id * len, end: cfg.epochStart + (id + 1) * len };

if (epoch.end > Date.now() / 1000) { console.error(`Epoch ${id} has not ended yet (ends ${new Date(epoch.end * 1000).toISOString()}).`); process.exit(1); }

const db = openDb(cfg);
if (db.prepare(`SELECT 1 FROM payouts WHERE epoch=? AND status='sent'`).get(id)) {
  console.error(`Epoch ${id} was already paid. See the payouts table.`); process.exit(1);
}

if (!cfg.prizeWallet) { console.error('Set PRIZE_WALLET in .env first.'); process.exit(1); }
const conn = new Connection(cfg.rpcUrl, 'confirmed');
const prizeWallet = new PublicKey(cfg.prizeWallet);
const balance = await conn.getBalance(prizeWallet);
const pot = Math.max(0, balance - Math.round(cfg.prizeReserveSol * LAMPORTS_PER_SOL));

const r = computeEpoch(db, cfg, epoch);
const rows = r.rows;
const plan = [];
const top = r.leaders[0];
if (top !== undefined) plan.push({ category: 'super-spreader', address: rows[top].address, lamports: Math.floor(pot * cfg.split.spreader), note: `score ${r.score[top]}` });
if (r.deepest >= 0) plan.push({ category: 'deepest-strain', address: rows[r.deepest].address, lamports: Math.floor(pot * cfg.split.deepest), note: `gen ${rows[r.deepest].gen}` });
const totalBurn = r.cure.reduce((s, c) => s + c.burned, 0);
for (const c of r.cure) plan.push({ category: 'cure-fund', address: c.address, lamports: Math.floor(pot * cfg.split.cure * (c.burned / totalBurn)), note: `burned ${Math.round(c.burned)}` });
// 0.001 SOL minimum so a transfer to an empty account still covers rent
const payable = plan.filter((p) => p.lamports >= 1_000_000);

console.log(`Epoch ${id}: ${new Date(epoch.start * 1000).toISOString()} → ${new Date(epoch.end * 1000).toISOString()}`);
console.log(`Prize wallet ${(balance / 1e9).toFixed(4)} SOL, paying out ${(pot / 1e9).toFixed(4)} SOL (keeping ${cfg.prizeReserveSol} SOL reserve)\n`);
console.table(payable.map((p) => ({ ...p, sol: (p.lamports / 1e9).toFixed(4) })));
if (!payable.length) { console.log('Nothing to pay.'); process.exit(0); }
if (!execute) { console.log('\nDry run. Re-run with --execute to send.'); process.exit(0); }

const secret = JSON.parse(fs.readFileSync(process.env.PRIZE_KEYPAIR || './prize-keypair.json', 'utf8'));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
if (!payer.publicKey.equals(prizeWallet)) { console.error('PRIZE_KEYPAIR does not match PRIZE_WALLET.'); process.exit(1); }

const ins = db.prepare(`INSERT INTO payouts(epoch,category,address,lamports,sig,status,created_at) VALUES(?,?,?,?,?,?,?)`);
for (let i = 0; i < payable.length; i += 10) {
  const chunk = payable.slice(i, i + 10);
  const tx = new Transaction();
  for (const p of chunk) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(p.address), lamports: p.lamports }));
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
    for (const p of chunk) ins.run(id, p.category, p.address, p.lamports, sig, 'sent', Math.floor(Date.now() / 1000));
    console.log('sent', sig);
  } catch (e) {
    for (const p of chunk) ins.run(id, p.category, p.address, p.lamports, null, 'failed', Math.floor(Date.now() / 1000));
    console.error('failed chunk:', e.message);
  }
}
