'use strict';
/**
 * verify-chain.js — the judge's proof.
 *
 * Reads the roots straight off the public chain and compares them to the local ledger.
 * If the server changed anything, this disagrees — and nothing the server does can fix that.
 *
 *   node scripts/verify-chain.js
 */
require('../lib/env');
const store = require('../lib/store');

(async () => {
  const cl = require('../lib/chain');
  const dep = cl.readDeployment();
  if (!dep) {
    console.error('  no deployment found — run: npm run deploy');
    process.exit(1);
  }

  const ledger = store.readLedger().filter((b) => b.chain !== 'LOCAL-SIMULATED');
  if (!ledger.length) {
    console.error('  no on-chain anchors in the ledger yet — set ANCHOR_ON_CHAIN=true and run npm run anchor');
    process.exit(1);
  }

  console.log(`\n  contract ${dep.address}`);
  console.log(`  network  ${dep.network}\n`);

  let ok = 0;
  let bad = 0;
  const bare = (h) => String(h || '').toLowerCase().replace(/^0x/, '');
  for (const b of ledger.slice(-12)) {
    const onChain = await cl.readRoot(b.seq ?? b.batch);
    const expected = b.checkpointRoot || b.root;
    const match = bare(onChain) === bare(expected);
    if (match) ok += 1;
    else bad += 1;
    console.log(`  batch ${String(b.batch).padStart(3)}  ${match ? '✓ matches chain' : '✗ DIFFERS'}  ${expected.slice(0, 18)}…`);
    if (b.explorer) console.log(`         ${b.explorer}`);
  }
  console.log(`\n  ${ok} match, ${bad} differ\n`);
  process.exit(bad ? 2 : 0);
})();
