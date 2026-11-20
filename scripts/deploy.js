'use strict';
/** deploy.js — compile + deploy LogAnchor to the configured chain. */
require('../lib/env');
const { deploy } = require('../lib/chain');

(async () => {
  if (!process.env.PRIVATE_KEY) {
    console.error('no PRIVATE_KEY — run: node scripts/wallet.js');
    process.exit(1);
  }
  console.log('compiling + deploying LogAnchor…');
  const { address, txHash } = await deploy(process.env.PRIVATE_KEY);
  console.log(`\n  deployed: ${address}`);
  console.log(`  tx      : ${txHash}\n`);
})();
