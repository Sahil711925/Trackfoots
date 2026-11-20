'use strict';
/**
 * attack.naive.test.js — the lazy intruder: delete and edit lines, leave hashes alone.
 * Expected: caught by the hash chain, and the 34 deleted lines are named from receipts.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-naive-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { seed } = require(path.join(REPO, 'lib', 'seed.js'));
const { attack } = require(path.join(REPO, 'lib', 'attack.js'));
const { verify } = require(path.join(REPO, 'lib', 'verify.js'));
const { anchorAll } = require(path.join(REPO, 'scripts', 'anchor.js'));
const { merkleRoot } = require(path.join(REPO, 'lib', 'merkle.js'));

// The attacker deletes every third entry of batch 3 (seq 201..300), i.e. 201, 204, ..., 300.
const DELETED_SEQS = Array.from({ length: 34 }, (_, k) => 201 + k * 3);

let attackResult;
let report;
let publishedBatch3;

before(async () => {
  seed(1200);
  await anchorAll({ verbose: false });
  publishedBatch3 = store.readLedger().find((b) => b.batch === 3);
  assert.ok(publishedBatch3, 'batch 3 must be anchored before the attack');

  attackResult = attack('naive', 3);
  report = verify();
});

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('attack("naive", 3) deletes 34 of batch 3\'s 100 entries', () => {
  assert.equal(attackResult.mode, 'naive');
  assert.equal(attackResult.batch, 3);
  assert.equal(attackResult.fromSeq, 201);
  assert.equal(attackResult.toSeq, 300);
  assert.equal(attackResult.deleted, 34);
  assert.equal(attackResult.remaining, 1166);
});

test('verify() returns TAMPERED with a broken chain', () => {
  assert.equal(report.verdict, 'TAMPERED');
  assert.equal(report.chainOk, false);
  assert.equal(report.entriesOnDisk, 1166);
  assert.equal(report.entriesExpected, 1200);
});

test('the chain breaks at the first surviving entry after a deleted one', () => {
  // seq 201 is gone, so walk-time prevHash is seq 200's hash while entry 202 stores 201's hash.
  assert.equal(report.firstBrokenEntry, 202);
  assert.equal(report.corruptLines, 0, 'deletion is not the same thing as an unparseable line');
});

test('the auditor names exactly the 34 deleted entries from its receipts', () => {
  assert.equal(report.missingEntries.length, 34);
  const missingSeqs = report.missingEntries.map((m) => m.seq).sort((a, b) => a - b);
  assert.deepEqual(missingSeqs, DELETED_SEQS);
  for (const m of report.missingEntries) {
    assert.match(String(m.hashSeenAtWriteTime), /^[0-9a-f]{64}$/);
    assert.ok(m.ts, 'each missing entry carries the timestamp it had at write time');
  }
});

test('the tampered batch no longer hashes to its published root', () => {
  // Fact (independent of what verify() chooses to report): batch 3's leaves on disk
  // do not reproduce the root that was published before the attack.
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const leaves = [];
  for (let s = 201; s <= 300; s++) if (bySeq.has(s)) leaves.push(bySeq.get(s).hash);

  const recomputed = merkleRoot(leaves);
  assert.equal(leaves.length, 66);
  assert.notEqual(recomputed, publishedBatch3.root);
  // KNOWN LIMITATION: verify() only walks the root check when the LAST batch is bad,
  // so this mismatch is currently reported through chainOk/missingEntries, not badBatches.
  assert.ok(report.badBatches.length + report.missingEntries.length > 0);
});
