// One-time, run on YOUR computer (not the server) with the dev wallet key:
// hands the bonding-curve pool's creator role (and its fee claims) to the prize wallet,
// so the dev key never has to live on the server.
//
//   DEV_KEYPAIR=~/dev-keypair.json node scripts/transfer-creator.js            preview
//   DEV_KEYPAIR=~/dev-keypair.json node scripts/transfer-creator.js --execute  transfer
//
// Only works while the token is still on the bonding curve. After graduation, send the
// DAMM v2 position NFT to the prize wallet from your wallet app instead.
import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { cfg } from '../src/config.js';
import { loadKeypair } from '../src/fees.js';

const dev = loadKeypair(process.env.DEV_KEYPAIR);
if (!cfg.prizeWallet) { console.error('Set PRIZE_WALLET in .env first.'); process.exit(1); }
const conn = new Connection(cfg.rpcUrl, 'confirmed');
const client = DynamicBondingCurveClient.create(conn, 'confirmed');
const vp = await client.state.getPoolByBaseMint(new PublicKey(cfg.mint));
if (!vp) { console.error('No bonding-curve pool found for MINT.'); process.exit(1); }
const current = vp.account.creator;
console.log(`Pool:            ${vp.publicKey.toBase58()}`);
console.log(`Current creator: ${current.toBase58()}`);
console.log(`New creator:     ${cfg.prizeWallet}`);
if (current.toBase58() === cfg.prizeWallet) { console.log('Already done.'); process.exit(0); }
if (!current.equals(dev.publicKey)) { console.error('DEV_KEYPAIR is not the current creator.'); process.exit(1); }
if (!process.argv.includes('--execute')) { console.log('\nPreview only. Re-run with --execute.'); process.exit(0); }
const tx = await client.creator.transferPoolCreator({ pool: vp.publicKey, creator: dev.publicKey, newCreator: new PublicKey(cfg.prizeWallet) });
console.log('sent', await sendAndConfirmTransaction(conn, tx, [dev]));
