'use strict';
/**
 * demo-up.js — one command that brings the whole demo to life.
 *
 * 1. starts a local EVM chain (ganache) if it is not already running
 * 2. starts the TRACKFOOTS server
 *
 * Why this exists: at the venue, nobody should have to remember three terminals.
 */
require('../lib/env');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const GANACHE = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'ganache.cmd' : 'ganache');
const KEY = process.env.LOCAL_PRIVATE_KEY || process.env.PRIVATE_KEY;

function probe(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end('{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}');
  });
}

(async () => {
  const chainUp = await probe(8545);
  if (chainUp) {
    console.log('  chain   : already running on 8545');
  } else if (!KEY) {
    console.log('  chain   : no key in .env — running without a chain');
  } else {
    console.log('  chain   : starting ganache…');
    const g = spawn(GANACHE, ['--wallet.accounts=' + KEY + ',1000000000000000000000', '--chain.chainId', '31337', '--port', '8545'], {
      cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32', detached: false,
    });
    g.on('error', (e) => console.log('  chain   : failed to start (' + e.message + ')'));
    await new Promise((r) => setTimeout(r, 3000));
  }

  // A fresh ganache has no contract. Deploy if the configured address has no code.
  try {
    const chain = require('../lib/chain');
    const dep = chain.readDeployment();
    const provider = chain.provider();
    let needsDeploy = !dep;
    if (dep) {
      const code = await provider.getCode(dep.address);
      needsDeploy = !code || code === '0x';
    }
    if (needsDeploy && KEY) {
      console.log('  contract: deploying LogAnchor…');
      const out = await chain.deploy(KEY);
      console.log('  contract: ' + out.address);
    } else if (dep) {
      console.log('  contract: ' + dep.address);
    }
  } catch (err) {
    console.log('  contract: skipped (' + (err.shortMessage || err.message) + ')');
  }

  console.log('  server  : http://localhost:5173\n');
  require('../server.js');
})();
