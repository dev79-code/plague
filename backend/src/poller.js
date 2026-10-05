// Follows the chain with plain Solana RPC: getSignaturesForAddress -> getTransaction.
// On first run it backfills from the very first transaction of the mint, then it
// keeps a cursor per watched address. Works with any RPC (Helius recommended).
import { mintDeltas } from './parse.js';
import { kv as kvStore } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makePoller({ rpc, db, cfg, apply, onChange, log = console }) {
  const kv = kvStore(db);
  const seen = db.prepare('SELECT 1 FROM processed WHERE sig=?');
  const addresses = [cfg.mint, ...cfg.extraWatch];

  async function listNewSignatures(address) {
    const until = kv.get(`cursor:${address}`);
    const out = [];
    let before;
    for (;;) {
      const opts = { limit: 1000, commitment: 'confirmed' };
      if (before) opts.before = before;
      if (until) opts.until = until;
      const page = await rpc('getSignaturesForAddress', [address, opts]);
      if (!page?.length) break;
      out.push(...page);
      before = page[page.length - 1].signature;
      if (page.length < 1000) break;
    }
    return out.reverse(); // oldest first
  }

  async function fetchTx(sig) {
    for (let i = 0; i < 4; i++) {
      const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      if (tx) return tx;
      await sleep(800);
    }
    return null;
  }

  async function syncAddress(address) {
    const sigs = await listNewSignatures(address);
    if (!sigs.length) return 0;
    if (sigs.length > 50) log.info?.(`[poller] ${address.slice(0, 6)}… ${sigs.length} new signatures`);
    let changes = 0;
    const BATCH = 8;
    for (let i = 0; i < sigs.length; i += BATCH) {
      const batch = sigs.slice(i, i + BATCH);
      const txs = await Promise.all(batch.map((s) => (s.err || seen.get(s.signature) ? null : fetchTx(s.signature))));
      for (let j = 0; j < batch.length; j++) {
        const s = batch[j];
        if (!s.err && !seen.get(s.signature)) {
          if (!txs[j]) return changes; // not available yet; retry next round without moving the cursor
          changes += apply(mintDeltas(txs[j], cfg.mint)).changes;
        }
        kv.set(`cursor:${address}`, s.signature);
      }
      if (changes) onChange?.();
    }
    return changes;
  }

  let running = false;
  async function loop() {
    if (running) return;
    running = true;
    for (;;) {
      for (const a of addresses) {
        try { await syncAddress(a); } catch (e) { log.error?.(`[poller] ${a.slice(0, 6)}…`, e.message); }
      }
      await sleep(cfg.pollMs);
    }
  }
  return { loop, syncAddress };
}
