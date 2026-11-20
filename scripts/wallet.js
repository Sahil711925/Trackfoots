'use strict';
/**
 * wallet.js — create a throwaway testnet wallet for the demo.
 * Prints the address so you can fund it from a faucet, and saves the key to .env
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const envPath = path.join(__dirname, '..', '.env');
const w = ethers.Wallet.createRandom();

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
if (/^PRIVATE_KEY=/m.test(env)) env = env.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${w.privateKey}`);
else env += `${env.endsWith('\n') || !env ? '' : '\n'}PRIVATE_KEY=${w.privateKey}\n`;

fs.writeFileSync(envPath, env);

console.log(`
  New demo wallet created.

  address : ${w.address}
  key     : saved to .env  (never commit this file)

  Fund it with free test MATIC, then run:  npm run deploy
  Faucets for Polygon Amoy:
    https://faucet.polygon.technology/        (choose Amoy, may need Polygon ID)
    https://www.alchemy.com/faucets/polygon-amoy
    https://faucet.quicknode.com/polygon/amoy
`);
