import { claimFees } from './fees.js';

export function recordClaims(db, results) {
  const ins = db.prepare('INSERT INTO fee_claims(t,source,pool,quote,quote_symbol,base,sig) VALUES(?,?,?,?,?,?,?)');
  const t = Math.floor(Date.now() / 1000);
  for (const r of results) if (r.status === 'claimed') ins.run(t, r.source, r.pool, r.quote, r.quoteSymbol, r.base, r.sig);
}

// Runs inside the server when FEE_CLAIM_HOURS > 0.
export function makeFeeJob({ db, cfg, onChange, log = console }) {
  return async function run() {
    try {
      const results = await claimFees(cfg, { execute: true, log });
      recordClaims(db, results);
      if (results.some((r) => r.status === 'claimed')) onChange?.();
    } catch (e) {
      log.error?.('[fees]', e.message);
    }
  };
}
