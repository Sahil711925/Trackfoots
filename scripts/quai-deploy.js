#!/usr/bin/env node
'use strict';
/**
 * quai-deploy.js — deploy LogAnchor to Quai Network (Orchard testnet by default).
 *
 *   node scripts/quai-deploy.js --check     price the deployment, spend nothing
 *   node scripts/quai-deploy.js             deploy (needs testnet QUAI for gas)
 *   node scripts/quai-deploy.js --anchor 1  write one checkpoint after deploying
 */
require('../lib/env');
const quai = require('../lib/chain-quai');

(async () => {
  const args = process.argv.slice(2);
  const netName = args.includes('--mainnet') ? 'mainnet' : 'orchard';
  const key = process.env.PRIVATE_KEY;
  if (!key) {
    console.error('no PRIVATE_KEY in the environment');
    process.exit(1);
  }

  const info = await quai.estimateDeploy(key, netName);
  console.log('network   ', info.network.name, '· chainId', info.network.chainId);
  console.log('rpc       ', info.network.rpc);
  console.log('account   ', info.address);
  console.log('balance   ', info.balance, 'wei');
  console.log('compiler  ', info.solc, '·', info.bytecodeBytes, 'byte contract');
  console.log('gas (est) ', info.gasEstimate || `unavailable: ${info.estimateError}`);

  if (args.includes('--check')) {
    const funded = BigInt(info.balance) > 0n;
    console.log(funded ? '\nfunded — ready to deploy' : '\nnot funded — deployment would be rejected for gas');
    process.exit(funded ? 0 : 2);
  }

  if (BigInt(info.balance) === 0n) {
    console.error('\nBalance is zero, so the node will reject the deployment for gas.');
    console.error('The faucet named in the Quai docs (orchard.faucet.quai.network) no longer resolves.');
    console.error(`QuaiDrop is live at ${info.network.faucet} — it needs a drop link from the organisers.`);
    console.error(`Send testnet QUAI to: ${info.address}`);
    process.exit(2);
  }

  const dep = await quai.deploy(key, netName);
  console.log('\ndeployed  ', dep.address);
  console.log('explorer  ', dep.explorer);

  if (args.includes('--anchor')) {
    const seq = Number(args[args.indexOf('--anchor') + 1]) || 1;
    const root = '0x' + 'ab'.repeat(32);
    const out = await quai.anchor(seq, root, process.env.ORG || 'Trackfoots', netName);
    console.log('anchored  ', out.txHash, '·', out.explorer);
  }
})().catch((err) => {
  console.error('FAILED:', err.shortMessage || err.message);
  process.exit(1);
});
