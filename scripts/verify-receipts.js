#!/usr/bin/env node
'use strict';
/**
 * verify-receipts.js — offline verifier for the receipt half of an evidence bundle.
 *
 *   node scripts/verify-receipts.js --bundle exports/bundle-42.json
 *   node scripts/verify-receipts.js exports/bundle-42.json
 *   node scripts/verify-receipts.js --bundle b.json --expect-root <hex> --expect-count <n>
 *
 * What it proves, with no access to data/ and no network:
 *   1. every receipt in the bundle carries a valid HMAC tag under RECEIPT_SECRET;
 *   2. the set of receipts present reproduces the committed receipt root.
 *
 * (2) is the one that catches a deletion. A receipt store the attacker controls can drop
 * receipts while leaving every surviving signature valid — the root is what notices.
 *
 * --expect-root exists because a root sitting in the same file as the receipts only proves
 * internal consistency: whoever rewrote the receipts could rewrite the root too. Pin the root
 * from an out-of-band source (the printed exhibit, a chain anchor, yesterday's bundle) and the
 * check becomes a real completeness proof. Same for --expect-count.
 *
 * Exit codes: 0 verified · 2 verification failed · 1 usage/IO error.
 */
process.env.ANCHOR_ON_CHAIN = process.env.ANCHOR_ON_CHAIN || 'false';

require('../lib/env');

const fs = require('fs');
const path = require('path');
const { verifyReceipts } = require('../lib/auditor');
const { buildReceiptRoot } = require('../lib/receipt-tree');

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: node scripts/verify-receipts.js --bundle <bundle.json> [--expect-root <hex>] [--expect-count <n>]');
  console.error('   or: node scripts/verify-receipts.js <bundle.json>');
  process.exit(1);
}

const argv = process.argv.slice(2);
let file = null;
let expectRoot = null;
let expectCount = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--bundle' || a === '-b') {
    file = argv[++i];
    if (!file) usage('--bundle needs a file');
  } else if (a === '--expect-root') {
    expectRoot = argv[++i];
    if (!expectRoot) usage('--expect-root needs a hex root');
    if (!/^[0-9a-f]{64}$/i.test(expectRoot)) usage(`not a sha256 root: ${expectRoot}`);
    expectRoot = expectRoot.toLowerCase();
  } else if (a === '--expect-count') {
    const n = argv[++i];
    if (!/^\d+$/.test(String(n))) usage(`--expect-count needs a whole number, got ${n}`);
    expectCount = Number(n);
  } else if (a === '--help' || a === '-h') {
    usage();
  } else if (a.startsWith('-')) {
    usage(`unknown option ${a}`);
  } else if (!file) {
    file = a;
  } else {
    usage(`unexpected argument ${a}`);
  }
}

if (!file) usage('no bundle given');
if (!fs.existsSync(file)) usage(`no such bundle: ${file}`);

let payload;
try {
  payload = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`error: ${file} is not valid JSON — ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(payload.receipts) && !payload.receiptRoot) {
  console.error(`\n  FAIL: ${path.basename(file)} carries no receipt set and no receipt root.`);
  console.error('        Re-export the bundle with scripts/export-bundle.js.\n');
  process.exit(2);
}

// An externally pinned root wins over whatever the file claims.
const pinned = expectRoot !== null;
if (pinned) payload.receiptRoot = expectRoot;
if (expectCount !== null) payload.receiptCount = expectCount;

const result = verifyReceipts(payload);
const s = result.summary || {};
const presented = Array.isArray(payload.receipts) ? payload.receipts.length : 0;
const distinct = (() => {
  try {
    return buildReceiptRoot(payload.receipts || []).count;
  } catch (err) {
    return null;
  }
})();

console.log('');
console.log(`  bundle     ${file}`);
console.log(`  receipts   ${presented} present${distinct !== null && distinct !== presented ? ` (${distinct} distinct)` : ''} · ${s.committed === null || s.committed === undefined ? 'no committed count' : `${s.committed} committed`}`);
console.log(`  root       ${payload.receiptRoot || '(none committed)'}`);
console.log(`  recomputed ${s.computedRoot || '(unavailable)'}`);
console.log('');

for (const c of result.checks) {
  const mark = c.ok === true ? '✔' : c.ok === false ? '✘' : '·';
  console.log(`  ${mark} ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`);
}

const sig = s.signatures || { valid: 0, invalid: 0, unsigned: 0 };
console.log('');
console.log(`  signatures ${sig.valid} valid · ${sig.invalid} invalid · ${sig.unsigned} unsigned · key ${s.keySource || 'unknown'}`);
if (pinned) console.log(`  root pinned out-of-band to ${expectRoot.slice(0, 24)}…${expectCount !== null ? ` (${expectCount} receipts)` : ''}`);
if (s.problem) console.log(`  finding    ${s.problem}`);

console.log('');
console.log(`  VERDICT: ${result.ok ? 'the receipt set is complete and authentic' : 'the receipt set does NOT verify'}`);
console.log('');

process.exit(result.ok ? 0 : 2);
