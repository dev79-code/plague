// Slow background jobs: true-up balances from chain, supply, prize wallet, price, .sol names.
import { Connection, PublicKey } from '@solana/web3.js';
import { kv as kvStore } from './db.js';
import { TOKEN_PROGRAM } from './config.js';

export function makeChainJobs({ rpc, db, cfg, onChange, log = console }) {
  const kv = kvStore(db);
  const pool = new Set(cfg.poolOwners);

  // Overwrites every balance with the real on-chain token account totals.
  async function reconcileBalances() {
    const filters = [{ memcmp: { offset: 0, bytes: cfg.mint } }];
    if (cfg.tokenProgram === TOKEN_PROGRAM) filters.unshift({ dataSize: 165 });
    const accounts = await rpc('getProgramAccounts', [cfg.tokenProgram, { encoding: 'jsonParsed', commitment: 'confirmed', filters }], { retries: 3 });
    const byOwner = new Map();
    let poolBal = 0;
    for (const a of accounts || []) {
      const info = a.account?.data?.parsed?.info;
      if (!info) continue;
      const amt = Number(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount ?? 0);
      if (pool.has(info.owner)) { poolBal += amt; continue; }
      byOwner.set(info.owner, (byOwner.get(info.owner) || 0) + amt);
    }
    const up = db.prepare(`INSERT INTO wallets(address,balance) VALUES(?,?) ON CONFLICT(address) DO UPDATE SET balance=excluded.balance`);
    db.transaction(() => {
      db.prepare(`UPDATE wallets SET balance=0 WHERE address<>'pool'`).run();
      for (const [o, b] of byOwner) up.run(o, b);
      db.prepare(`UPDATE wallets SET balance=? WHERE address='pool'`).run(poolBal);
    })();
    kv.set('holders', [...byOwner.values()].filter((b) => b > 0).length);
    log.info?.(`[chain] reconciled ${byOwner.size} holders`);
    onChange?.();
  }

  async function refreshStats() {
    try {
      const s = await rpc('getTokenSupply', [cfg.mint]);
      kv.set('supply', Number(s.value.uiAmountString));
    } catch (e) { log.error?.('[chain] supply', e.message); }
    if (cfg.prizeWallet) {
      try {
        const b = await rpc('getBalance', [cfg.prizeWallet, { commitment: 'confirmed' }]);
        kv.set('prize_lamports', b.value);
      } catch (e) { log.error?.('[chain] prize', e.message); }
    }
    try { // optional: price in SOL from DexScreener's public API
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${cfg.mint}`);
      if (r.ok) {
        const pairs = await r.json();
        const best = (Array.isArray(pairs) ? pairs : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        if (best?.priceNative) kv.set('price_sol', Number(best.priceNative));
      }
    } catch { /* price is optional */ }
    onChange?.();
  }

  // Looks up the primary .sol name of the most relevant wallets, a batch at a time.
  let conn;
  async function resolveNames() {
    if (!cfg.namesEnabled) return;
    let sns;
    try { sns = await import('@bonfida/spl-name-service'); } catch { return; }
    conn ||= new Connection(cfg.rpcUrl, 'confirmed');
    const week = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rows = db.prepare(`SELECT address FROM wallets
       WHERE address<>'pool' AND (infected_at IS NOT NULL OR balance>0)
         AND (name_checked_at IS NULL OR name_checked_at < ?)
       ORDER BY name_checked_at IS NOT NULL, balance DESC LIMIT 100`).all(week);
    if (!rows.length) return;
    try {
      const keys = rows.map((r) => new PublicKey(r.address));
      const names = await sns.getMultiplePrimaryDomains(conn, keys);
      const up = db.prepare('UPDATE wallets SET name=?, name_checked_at=? WHERE address=?');
      const now = Math.floor(Date.now() / 1000);
      db.transaction(() => rows.forEach((r, i) => up.run(names[i] ? `${names[i]}.sol` : null, now, r.address)))();
      if (names.some(Boolean)) onChange?.();
    } catch (e) { log.error?.('[chain] names', e.message); }
  }

  return { reconcileBalances, refreshStats, resolveNames };
}
