// Builds fake transactions in the exact shape getTransaction returns, for tests and demo data.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const addr = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * 58)]).join('');

let n = 0;
// changes: [{ owner, pre, post }] in whole tokens
export function fakeTx({ mint, t, changes, decimals = 6, err = null }) {
  n++;
  const toRaw = (x) => String(BigInt(Math.round(x * 10 ** decimals)));
  const pre = [], post = [];
  changes.forEach((c, i) => {
    const base = { accountIndex: i + 1, mint, owner: c.owner, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
    if (c.pre != null) pre.push({ ...base, uiTokenAmount: { amount: toRaw(c.pre), decimals, uiAmount: c.pre, uiAmountString: String(c.pre) } });
    if (c.post != null) post.push({ ...base, uiTokenAmount: { amount: toRaw(c.post), decimals, uiAmount: c.post, uiAmountString: String(c.post) } });
  });
  return {
    slot: 300_000_000 + n,
    blockTime: t,
    transaction: { signatures: [`sig${n}_${addr().slice(0, 20)}`] },
    meta: { err, preTokenBalances: pre, postTokenBalances: post },
  };
}

// Keeps balances so generated transfers are consistent.
export function ledger(mint) {
  const bal = new Map();
  const get = (o) => bal.get(o) || 0;
  function move(t, moves) { // moves: [{owner, delta}]
    const changes = moves.map((m) => {
      const pre = get(m.owner), post = Math.max(0, pre + m.delta);
      bal.set(m.owner, post);
      return { owner: m.owner, pre: pre || null, post: post || null };
    });
    return fakeTx({ mint, t, changes });
  }
  return { bal, get, move };
}
