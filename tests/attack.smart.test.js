'use strict';
/**
 * attack.smart.test.js — the careful intruder: delete, edit, and recompute every hash
 * so the chain is internally consistent. Only the roots published before the attack
 * (and the auditor's receipts) can expose him.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-smart-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { seed } = require(path.join(REPO, 'lib', 'seed.js'));
const { attack } = require(path.join(REPO, 'lib', 'attack.js'));
const { verify } = require(path.join(REPO, 'lib', 'verify.js'));
const { anchorAll } = require(path.join(REPO, 'scripts', 'anchor.js'));

const DELETED_ORIGINAL_SEQS = Array.from({ length: 34 }, (_, k) => 201 + k * 3);

let attackResult;
let report;

before(async () => {
  seed(1200);
  await anchorAll({ verbose: false });
  attackResult = attack('smart', 3);
  report = verify();
});

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('attack("smart", 3) deletes the same 34 entries', () => {
  assert.equal(attackResult.mode, 'smart');
  assert.equal(attackResult.batch, 3);
  assert.equal(attackResult.deleted, 34);
  assert.equal(attackResult.remaining, 1166);
});

test('the recomputed chain stays internally valid — chainOk is still true', () => {
  assert.equal(report.chainOk, true);
  assert.equal(report.firstBrokenEntry, null);
  assert.equal(report.corruptLines, 0);
});

test('verify() still returns TAMPERED and points at batch 3', () => {
  assert.equal(report.verdict, 'TAMPERED');
  assert.equal(report.entriesOnDisk, 1166);
  assert.equal(report.entriesExpected, 1200);
  assert.ok(report.badBatches.length > 0, 'a re-chained log must be caught by the published roots');

  const first = report.badBatches[0];
  assert.equal(first.batch, 3);
  assert.match(first.seqRange, /^201-300$/);
  assert.notEqual(first.recomputedRoot, first.publishedRoot);
  assert.equal(first.entriesPresent, 66);
  assert.equal(first.entriesExpected, 100);
});

test('the shift corrupts the roots of every batch from 3 onward', () => {
  // Renumbering pulls later entries into earlier batches, so 3..12 can no longer match.
  const badBatchNos = report.badBatches.map((b) => b.batch);
  assert.deepEqual(badBatchNos, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('the auditor still names exactly 34 missing entries', () => {
  assert.equal(report.missingEntries.length, 34);
  const missingSeqs = report.missingEntries.map((m) => m.seq).sort((a, b) => a - b);
  assert.deepEqual(missingSeqs, DELETED_ORIGINAL_SEQS);
});

test('the rewritten log keeps a valid per-entry hash chain over its new sequence numbers', () => {
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  assert.equal(entries.length, 1166);
  assert.equal(entries[0].prevHash, 'GENESIS');
  assert.deepEqual([entries[0].seq, entries[1].seq], [1, 2]);
  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i].seq, i + 1, 'smart attack renumbers contiguously');
    assert.equal(entries[i].prevHash, entries[i - 1].hash);
    assert.equal(entries[i].hash, store.entryDigest(entries[i], entries[i].prevHash));
  }
});
