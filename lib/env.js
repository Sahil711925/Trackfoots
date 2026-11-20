'use strict';
/** env.js — load .env without any dependency. Require this before reading process.env. */
const fs = require('fs');
const path = require('path');

/**
 * A small explicit set of keys always comes from the FILE, even if the shell already has them.
 * Reason: a stray WITNESS_DATA / ANCHOR_ON_CHAIN inherited from a parent process silently
 * redirected the app to a temp directory with anchoring switched off — everything still
 * "worked" while quietly never touching the chain.
 */
const FORCE_FROM_FILE = new Set(['CHAIN', 'RPC_URL', 'ANCHOR_ON_CHAIN', 'WITNESS_DATA', 'PRIVATE_KEY', 'LOCAL_PRIVATE_KEY', 'ORG', 'RECEIPT_SECRET']);

// Test runs must be able to force ANCHOR_ON_CHAIN=false (or point WITNESS_DATA at a temp dir)
// without the file overriding them. Otherwise the suite dials a live chain, collides on nonces
// and hangs with no failing assertion.
const TEST_MODE = process.env.WITNESS_TEST === '1';

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined || (!TEST_MODE && FORCE_FROM_FILE.has(m[1]))) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
module.exports = {};
