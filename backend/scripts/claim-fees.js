// Claims Meteora creator fees into the prize wallet.
//
//   node scripts/claim-fees.js            shows what can be claimed (no transaction)
//   node scripts/claim-fees.js --execute  claims it
//
// Set FEE_CLAIM_HOURS in .env to have the server do this automatically.
import { cfg } from '../src/config.js';
import { openDb } from '../src/db.js';
import { claimFees, loadKeypair } from '../src/fees.js';
import { recordClaims } from '../src/feejob.js';

const execute = process.argv.includes('--execute');
const signer = loadKeypair(cfg.feeClaimKeypair);
console.log(`Claim key: ${signer.publicKey.toBase58()}`);
console.log(`Receiver:  ${cfg.prizeWallet || signer.publicKey.toBase58()} (prize wallet)\n`);
const results = await claimFees(cfg, { execute, signer, log: { info: () => {} } });
console.table(results.map((r) => ({
  source: r.source, status: r.status,
  quote: r.quote != null ? `${r.quote.toFixed(4)} ${r.quoteSymbol}` : '',
  plague: r.base != null ? Math.round(r.base) : '',
  note: r.note || r.sig || '',
})));
if (execute) recordClaims(openDb(cfg), results);
else if (results.some((r) => r.status === 'ready')) console.log('\nRe-run with --execute to claim.');
