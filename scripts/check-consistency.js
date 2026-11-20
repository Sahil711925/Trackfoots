'use strict';
/**
 * check-consistency.js — CLI: is the published log append-only across time?
 *   node scripts/check-consistency.js [--json]
 */
require('../lib/env');
const { checkChainOfCheckpoints } = require('../lib/consistency');

const asJson = process.argv.includes('--json');
const r = checkChainOfCheckpoints();

if (asJson) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 2);
}

console.log(`\nTrackfoots append-only check`);
console.log(`  batches            ${r.batches}`);
console.log(`  leaves on disk     ${r.leaves}`);
console.log(`  checkpoint pairs   ${r.totalPairs}\n`);

for (const p of r.pairs) {
  const mark = p.verified ? '✔' : '✘';
  console.log(`  ${mark} batch ${String(p.from).padStart(2)} → ${String(p.to).padStart(2)}  ${p.oldSize}→${p.newSize} leaves  proof ${p.proofLength} hashes`);
  if (!p.verified) console.log(`      ${p.reason}`);
}

console.log(
  r.ok
    ? `\n  APPEND-ONLY: every published batch extends the one before it (${r.verifiedPairs}/${r.totalPairs})\n`
    : `\n  HISTORY BROKEN: ${r.totalPairs - r.verifiedPairs} pair(s) do not extend\n`
);
process.exit(r.ok ? 0 : 2);
