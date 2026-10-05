// Turns a Solana transaction (getTransaction / Helius raw-webhook format) into
// net $PLAGUE balance changes per wallet owner. Using pre/post token balances
// means swaps routed through Jupiter, multi-hop routes and airdrop tools all
// collapse to "who lost tokens, who gained tokens".

export function mintDeltas(tx, mint) {
  if (!tx || !tx.meta) return null;
  const sig = tx.transaction?.signatures?.[0] ?? tx.signature ?? tx.signatures?.[0];
  const byOwner = new Map(); // owner -> { pre: bigint, post: bigint, dec }

  const take = (list, key) => {
    for (const b of list || []) {
      if (b.mint !== mint || !b.owner) continue;
      const raw = BigInt(b.uiTokenAmount?.amount ?? '0');
      const dec = b.uiTokenAmount?.decimals ?? 0;
      const e = byOwner.get(b.owner) || { pre: 0n, post: 0n, dec };
      e[key] += raw;
      e.dec = dec;
      byOwner.set(b.owner, e);
    }
  };
  take(tx.meta.preTokenBalances, 'pre');
  take(tx.meta.postTokenBalances, 'post');

  const deltas = [];
  for (const [owner, e] of byOwner) {
    const d = e.post - e.pre;
    if (d !== 0n) deltas.push({ owner, delta: Number(d) / 10 ** e.dec });
  }
  return { sig, slot: tx.slot ?? null, t: tx.blockTime ?? null, err: tx.meta.err ?? null, deltas };
}
