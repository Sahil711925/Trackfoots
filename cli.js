#!/usr/bin/env node
'use strict';
/**
 * cli.js — what the auditor runs.
 *   node cli.js verify
 *   node cli.js prove <seq>
 */
const { verify, proveEntry } = require('./lib/verify');

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const cmd = process.argv[2] || 'verify';

if (cmd === 'prove') {
  const seq = Number(process.argv[3]);
  const p = proveEntry(seq);
  if (!p) { console.log(C.red(`entry ${seq} not found (it may have been deleted)`)); process.exit(1); }
  console.log(C.bold(`Inclusion proof for entry ${seq}`));
  console.log(`  batch     ${p.batch}`);
  console.log(`  root      ${p.root}`);
  console.log(`  tx        ${p.txHash}`);
  console.log(`  proof     ${p.proof.length} sibling hashes`);
  console.log(C.dim('  anyone can rebuild the root from this entry + these hashes.'));
  process.exit(0);
}

const r = verify();
const line = '─'.repeat(66);

console.log(`\n${line}`);
if (r.verdict === 'VERIFIED') {
  console.log(C.green('  ✓ LOG INTEGRITY: VERIFIED'));
} else {
  console.log(C.red(`  ✗ LOG INTEGRITY: ${r.verdict}`));
}
console.log(line);
console.log(`  entries on disk      ${r.entriesOnDisk}`);
console.log(`  entries at write time ${r.entriesExpected}`);
console.log(`  batches published     ${r.batchesPublished}`);
console.log(`  hash chain            ${r.chainOk ? C.green('intact') : C.red(`broken at entry ${r.firstBrokenEntry}`)}`);
if (r.corruptLines) console.log(`  corrupt lines         ${C.red(r.corruptLines)}`);

if (r.badBatches.length) {
  console.log(`\n  ${C.red('MISMATCH AGAINST PUBLISHED ROOTS')}`);
  for (const b of r.badBatches.slice(0, 6)) {
    console.log(C.red(`   batch ${b.batch}  entries ${b.seqRange}`));
    console.log(C.dim(`     published  ${b.publishedRoot}`));
    console.log(C.dim(`     recomputed ${b.recomputedRoot}`));
    console.log(C.dim(`     tx ${b.txHash}`));
  }
  if (r.badBatches.length > 6) console.log(C.dim(`   …and ${r.badBatches.length - 6} more batches`));
}

if (r.missingEntries.length) {
  console.log(`\n  ${C.yellow('DELETED ENTRIES RECOVERED FROM AUDITOR RECEIPTS')}  ${r.missingEntries.length}`);
  for (const m of r.missingEntries.slice(0, 8)) {
    console.log(C.yellow(`   entry ${m.seq}  existed at ${m.ts}  hash ${m.hashSeenAtWriteTime.slice(0, 20)}…`));
  }
  if (r.missingEntries.length > 8) console.log(C.dim(`   …and ${r.missingEntries.length - 8} more`));
}

if (r.alteredEntries.length) {
  console.log(`\n  ${C.yellow('ENTRIES CHANGED AFTER THE FACT')}  ${r.alteredEntries.length}`);
  for (const a of r.alteredEntries.slice(0, 6)) {
    console.log(C.yellow(`   entry ${a.seq}  was ${a.hashAtWriteTime.slice(0, 16)}…  now ${a.hashNow.slice(0, 16)}…`));
  }
}

console.log(`\n  verdict: ${r.verdict === 'VERIFIED' ? C.green('these logs are genuine') : C.red('these logs cannot be trusted')}`);
console.log(`${line}\n`);
process.exit(r.verdict === 'VERIFIED' ? 0 : 2);
