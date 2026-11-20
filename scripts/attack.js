'use strict';
/**
 * attack.js — CLI wrapper around lib/attack.js
 *   node scripts/attack.js [naive|smart] [batchNumber]
 */
const { attack } = require('../lib/attack');

const mode = process.argv[2] || 'naive';
const batch = Number(process.argv[3] || 3);

console.log(`\n  attacker: I have root on this box.`);
console.log(`  mode     : ${mode.toUpperCase()}\n`);
try {
  const r = attack(mode, batch);
  console.log(`  target   : batch ${r.batch} (entries ${r.fromSeq}-${r.toSeq})`);
  console.log(`  deleted  ${r.deleted} entries`);
  console.log(`  edited   ${r.edited} entries (incriminating commands rewritten)`);
  if (mode === 'smart') console.log(`  recalculated all ${r.remaining} hashes — the file is now internally perfect`);
  console.log(`\n  the diary on disk now looks ${mode === 'smart' ? 'completely legitimate' : 'mostly intact'}.\n`);
} catch (err) {
  console.error(`  ${err.message}`);
  process.exit(1);
}
