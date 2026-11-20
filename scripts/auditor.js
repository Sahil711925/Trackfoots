'use strict';
/**
 * auditor.js — offline auditor CLI. Reads a bundle JSON and the chain. Nothing else.
 *
 *   node scripts/auditor.js exports/bundle-250.json
 *   node scripts/auditor.js exports/bundle-250.json --offline   (no chain read)
 */
require('../lib/env');
const fs = require('fs');
const { verifyPayload } = require('../lib/auditor');

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/auditor.js <bundle.json> [--offline]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`no such bundle: ${file}`);
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const offline = process.argv.includes('--offline');

  let readChainRoot;
  if (!offline) {
    try {
      const chain = require('../lib/chain');
      if (chain.readDeployment()) readChainRoot = (seq) => chain.readRoot(seq);
    } catch (err) {
      console.error(`  chain unavailable (${err.message}) — continuing offline`);
    }
  }

  const r = await verifyPayload(payload, { readChainRoot });

  console.log(`\n  bundle   ${file}`);
  console.log(`  entry    ${payload.seq}`);
  console.log(`  root     ${String(payload.checkpointRoot).slice(0, 32)}…\n`);

  for (const c of r.checks) {
    const mark = c.ok === true ? '✔' : c.ok === false ? '✘' : '·';
    console.log(`  ${mark} ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`);
  }

  console.log(`\n  VERDICT: ${r.verified ? 'the bundle is genuine' : 'the bundle does NOT verify'}\n`);
  process.exit(r.verified ? 0 : 2);
})();
