// Claims your Meteora creator fees into the prize wallet.
//
//  - Bonding curve (DBC): creator trading fees. The claim key must be the pool's creator.
//  - DAMM v2 (after graduation): fees on LP positions owned by the claim key in any pool with $PLAGUE.
//
// The claim key signs and pays the network fee. Everything claimed is sent to PRIZE_WALLET.
import fs from 'node:fs';
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';

const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export function loadKeypair(path) {
  if (!path || !fs.existsSync(path)) throw new Error(`Keypair file not found: ${path}. Put the JSON keypair there (see README).`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))));
}

async function loadSdks() {
  const dbc = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  const amm = await import('@meteora-ag/cp-amm-sdk');
  return { dbc, amm };
}

export async function claimFees(cfg, { execute = false, log = console, signer, conn, sdks, send } = {}) {
  conn ||= new Connection(cfg.rpcUrl, 'confirmed');
  signer ||= loadKeypair(cfg.feeClaimKeypair);
  sdks ||= await loadSdks();
  send ||= (tx) => {
    if (cfg.priorityMicroLamports > 0) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityMicroLamports }));
    return sendAndConfirmTransaction(conn, tx, [signer], { commitment: 'confirmed' });
  };
  const owner = signer.publicKey;
  const receiver = new PublicKey(cfg.prizeWallet || owner.toBase58());
  const mint = new PublicKey(cfg.mint);
  const decimalsCache = new Map();
  const decimals = async (m) => {
    const k = m.toBase58();
    if (k === NATIVE_MINT) return 9;
    if (!decimalsCache.has(k)) decimalsCache.set(k, (await conn.getTokenSupply(m)).value.decimals);
    return decimalsCache.get(k);
  };
  const ui = (bn, dec) => Number(bn.toString()) / 10 ** dec;
  const symbol = (m) => (m.toBase58() === NATIVE_MINT ? 'SOL' : m.toBase58() === cfg.mint ? 'PLAGUE' : m.toBase58().slice(0, 4) + '…');
  const results = [];

  /* ---- bonding curve ---- */
  try {
    const client = sdks.dbc.DynamicBondingCurveClient.create(conn, 'confirmed');
    const vp = await client.state.getPoolByBaseMint(mint);
    if (!vp) {
      results.push({ source: 'bonding curve', status: 'none', note: 'No bonding-curve pool for this mint' });
    } else if (!vp.account.creator.equals(owner)) {
      results.push({ source: 'bonding curve', status: 'skipped', note: `Pool creator is ${vp.account.creator.toBase58()}, not the claim key ${owner.toBase58()}` });
    } else {
      const config = await client.state.getPoolConfig(vp.account.config);
      const quoteMint = new PublicKey(config.quoteMint);
      const m = await client.state.getPoolFeeMetrics(vp.publicKey);
      const quote = ui(m.current.creatorQuoteFee, await decimals(quoteMint));
      const base = ui(m.current.creatorBaseFee, await decimals(mint));
      const r = { source: 'bonding curve', quote, quoteSymbol: symbol(quoteMint), base, pool: vp.publicKey.toBase58() };
      if (quote < cfg.minClaimQuote && base <= 0) results.push({ ...r, status: 'below minimum' });
      else if (!execute) results.push({ ...r, status: 'ready' });
      else {
        const tx = await client.creator.claimCreatorTradingFeeToReceiver({
          creator: owner, payer: owner, pool: vp.publicKey, receiver,
          maxBaseAmount: sdks.dbc.U64_MAX, maxQuoteAmount: sdks.dbc.U64_MAX,
        });
        results.push({ ...r, status: 'claimed', sig: await send(tx) });
      }
    }
  } catch (e) {
    results.push({ source: 'bonding curve', status: 'error', note: e.message });
  }

  /* ---- DAMM v2 positions ---- */
  try {
    const cp = new sdks.amm.CpAmm(conn);
    const positions = await cp.getPositionsByUserAndTokenMint(owner, mint);
    if (!positions.length) results.push({ source: 'DAMM v2', status: 'none', note: 'No DAMM v2 positions owned by the claim key' });
    for (const p of positions) {
      const s = p.poolState;
      const fee = sdks.amm.getUnClaimLpFee(s, p.positionState);
      const aIsOurs = s.tokenAMint.equals(mint);
      const quoteMint = aIsOurs ? s.tokenBMint : s.tokenAMint;
      const quote = ui(aIsOurs ? fee.feeTokenB : fee.feeTokenA, await decimals(quoteMint));
      const base = ui(aIsOurs ? fee.feeTokenA : fee.feeTokenB, await decimals(mint));
      const r = { source: 'DAMM v2', quote, quoteSymbol: symbol(quoteMint), base, pool: p.pool.toBase58() };
      if (quote < cfg.minClaimQuote && base <= 0) { results.push({ ...r, status: 'below minimum' }); continue; }
      if (!execute) { results.push({ ...r, status: 'ready' }); continue; }
      try {
        const tx = await cp.claimPositionFee2({
          owner, receiver, feePayer: owner,
          pool: p.pool, position: p.position, positionNftAccount: p.positionNftAccount,
          tokenAMint: s.tokenAMint, tokenBMint: s.tokenBMint,
          tokenAVault: s.tokenAVault, tokenBVault: s.tokenBVault,
          tokenAProgram: sdks.amm.getTokenProgram(s.tokenAFlag), tokenBProgram: sdks.amm.getTokenProgram(s.tokenBFlag),
        });
        results.push({ ...r, status: 'claimed', sig: await send(tx) });
      } catch (e) { results.push({ ...r, status: 'error', note: e.message }); }
    }
  } catch (e) {
    results.push({ source: 'DAMM v2', status: 'error', note: e.message });
  }

  for (const r of results) {
    const amt = r.quote != null ? ` ${r.quote.toFixed(4)} ${r.quoteSymbol} + ${Math.round(r.base)} PLAGUE` : '';
    log.info?.(`[fees] ${r.source}: ${r.status}${amt}${r.note ? ' — ' + r.note : ''}${r.sig ? ' ' + r.sig : ''}`);
  }
  return results;
}
