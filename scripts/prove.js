#!/usr/bin/env node
'use strict';
/**
 * prove.js — print a Merkle inclusion proof for ONE entry.
 *
 *   node scripts/prove.js 250
 *   node scripts/prove.js 250 --json
 *
 * Exit codes: 0 proven · 2 not proven (tampered / root mismatch) · 1 no such entry
 */
require('../lib/env');
const { buildProof, formatProofText } = require('../lib/proof');

const argv = process.argv.slice(2);
const wantsJson = argv.includes('--json') || argv.includes('-j');
const seqArg = argv.find((a) => !a.startsWith('-'));

if (!seqArg) {
  console.error('usage: node scripts/prove.js <seq> [--json]');
  process.exit(1);
}
if (!/^\d+$/.test(seqArg)) {
  console.error(`invalid seq "${seqArg}" — expected a positive integer`);
  process.exit(1);
}

let proof;
try {
  proof = buildProof(Number(seqArg));
} catch (err) {
  console.error(`error building proof for #${seqArg}: ${err.message}`);
  process.exit(1);
}

if (!proof) {
  console.error(`no proof for entry #${seqArg} — not on disk, or never included in a published batch`);
  process.exit(1);
}

console.log(wantsJson ? JSON.stringify(proof, null, 2) : formatProofText(proof));
process.exit(proof.verified ? 0 : 2);
