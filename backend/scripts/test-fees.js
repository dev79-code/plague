// Fee-claim logic tests with stubbed Meteora SDKs: node scripts/test-fees.js
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';

const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const mint = Keypair.generate().publicKey, prize = Keypair.generate().publicKey;
Object.assign(process.env, { RPC_URL: 'http://127.0.0.1:1', MINT: mint.toBase58(), DEV_WALLET: Keypair.generate().publicKey.toBase58(), PRIZE_WALLET: prize.toBase58(), DB_PATH: ':memory:', MIN_CLAIM_QUOTE: '0.02' });
const { cfg } = await import('../src/config.js');
const { claimFees } = await import('../src/fees.js');

const signer = Keypair.generate();
const big = (n) => ({ toString: () => String(n) });
const calls = [];
function makeSdks({ creator = signer.publicKey, dbcQuote = 0.5e9, positions = [] } = {}) {
  const pool = Keypair.generate().publicKey, config = Keypair.generate().publicKey;
  return {
    dbc: {
      U64_MAX: 'U64_MAX',
      DynamicBondingCurveClient: { create: () => ({
        state: {
          getPoolByBaseMint: async (m) => (m.equals(mint) ? { publicKey: pool, account: { creator, config } } : null),
          getPoolConfig: async () => ({ quoteMint: SOL }),
          getPoolFeeMetrics: async () => ({ current: { creatorQuoteFee: big(dbcQuote), creatorBaseFee: big(0) } }),
        },
        creator: { claimCreatorTradingFeeToReceiver: async (p) => { calls.push(['dbc', p]); return { instructions: [] }; } },
      }) },
    },
    amm: {
      CpAmm: class { async getPositionsByUserAndTokenMint() { return positions; } async claimPositionFee2(p) { calls.push(['amm', p]); return { instructions: [] }; } },
      getUnClaimLpFee: (s, ps) => ps.fee,
      getTokenProgram: (f) => `prog${f}`,
    },
  };
}
const conn = { getTokenSupply: async () => ({ value: { decimals: 6 } }) };
const send = async () => 'SIG';
const quiet = { info: () => {} };

// dry run: nothing sent
let r = await claimFees(cfg, { signer, conn, sdks: makeSdks(), send, log: quiet });
assert.equal(r[0].status, 'ready'); assert.equal(r[0].quote, 0.5); assert.equal(r[0].quoteSymbol, 'SOL'); assert.equal(calls.length, 0);

// execute: claims to the prize wallet, signed by the creator
r = await claimFees(cfg, { execute: true, signer, conn, sdks: makeSdks(), send, log: quiet });
assert.equal(r[0].status, 'claimed'); assert.equal(r[0].sig, 'SIG');
const [, p] = calls.pop();
assert.ok(p.receiver.equals(prize)); assert.ok(p.creator.equals(signer.publicKey)); assert.equal(p.maxQuoteAmount, 'U64_MAX');

// wrong creator: skipped
r = await claimFees(cfg, { execute: true, signer, conn, sdks: makeSdks({ creator: Keypair.generate().publicKey }), send, log: quiet });
assert.equal(r[0].status, 'skipped'); assert.equal(calls.length, 0);

// below minimum
r = await claimFees(cfg, { execute: true, signer, conn, sdks: makeSdks({ dbcQuote: 0.01e9 }), send, log: quiet });
assert.equal(r[0].status, 'below minimum');

// DAMM v2 position: our mint is token A, SOL is token B
const poolState = { tokenAMint: mint, tokenBMint: SOL, tokenAVault: Keypair.generate().publicKey, tokenBVault: Keypair.generate().publicKey, tokenAFlag: 0, tokenBFlag: 0 };
const pos = { pool: Keypair.generate().publicKey, position: Keypair.generate().publicKey, positionNftAccount: Keypair.generate().publicKey, poolState, positionState: { fee: { feeTokenA: big(5e6), feeTokenB: big(1.2e9) } } };
r = await claimFees(cfg, { execute: true, signer, conn, sdks: makeSdks({ dbcQuote: 0, positions: [pos] }), send, log: quiet });
const amm = r.find((x) => x.source === 'DAMM v2');
assert.equal(amm.status, 'claimed'); assert.equal(amm.quote, 1.2); assert.equal(amm.base, 5);
const [kind, ap] = calls.pop();
assert.equal(kind, 'amm'); assert.ok(ap.receiver.equals(prize)); assert.ok(ap.owner.equals(signer.publicKey)); assert.equal(ap.tokenAProgram, 'prog0');
console.log('All fee-claim tests passed ✔');
