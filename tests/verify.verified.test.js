'use strict';
/**
 * verify.verified.test.js — the happy path: 1,200 seeded entries, anchored offline,
 * must audit as VERIFIED with every batch root reproducible from disk.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-verified-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1'; // never dial a chain during tests
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { seed } = require(path.join(REPO, 'lib', 'seed.js'));
const { verify, proveEntry } = require(path.join(REPO, 'lib', 'verify.js'));
const { anchorAll } = require(path.join(REPO, 'scripts', 'anchor.js'));
const { merkleRoot, verifyProof } = require(path.join(REPO, 'lib', 'merkle.js'));

let report;
let ledger;

before(async () => {
  seed(1200);
  const published = await anchorAll({ verbose: false });
  assert.equal(published.length, 12, 'twelve 100-entry batches expected');
  ledger = store.readLedger();
  report = verify();
});

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('verify() reports VERIFIED on fresh seeded and anchored data', () => {
  assert.equal(report.verdict, 'VERIFIED');
  assert.equal(report.chainOk, true);
  assert.equal(report.entriesOnDisk, 1200);
  assert.equal(report.entriesExpected, 1200);
  assert.equal(report.batchesPublished, 12);
  assert.equal(report.firstBrokenEntry, null);
  assert.equal(report.corruptLines, 0);
  assert.deepEqual(report.badBatches, []);
  assert.deepEqual(report.missingEntries, []);
});

test('verify() report carries the documented shape', () => {
  for (const field of ['verdict', 'entriesOnDisk', 'entriesExpected', 'batchesPublished', 'chainOk', 'firstBrokenEntry', 'badBatches', 'missingEntries']) {
    assert.ok(field in report, `report.${field} missing`);
  }
  assert.ok(ledger.length === 12);
  assert.match(String(report.checkedAt), /^\d{4}-\d{2}-\d{2}T/);
});

test('the ledger covers every entry exactly once, 100 per batch', () => {
  const ranges = ledger.map((b) => [b.fromSeq, b.toSeq, b.count]);
  assert.deepEqual(ranges[0], [1, 100, 100]);
  assert.deepEqual(ranges[11], [1101, 1200, 100]);
  assert.equal(ledger.reduce((sum, b) => sum + b.count, 0), 1200);
  for (let i = 1; i < ledger.length; i++) {
    assert.equal(ledger[i].fromSeq, ledger[i - 1].toSeq + 1, 'batches must be contiguous');
  }
});

test('every published root is independently reproducible from the log entries', () => {
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  const bySeq = new Map(entries.map((e) => [e.seq, e]));

  for (const batch of ledger) {
    const leaves = [];
    for (let s = batch.fromSeq; s <= batch.toSeq; s++) leaves.push(bySeq.get(s).hash);
    assert.equal(merkleRoot(leaves), batch.root, `batch ${batch.batch} root must recompute`);
  }
});

test('an inclusion proof for entry 250 rebuilds the published batch-3 root', () => {
  const p = proveEntry(250);
  assert.ok(p, 'entry 250 must be provable');
  assert.equal(p.batch, 3);
  assert.equal(p.index, 49); // 250 - 201
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  const leaf = entries.find((e) => e.seq === 250).hash;
  assert.equal(verifyProof(leaf, p.proof, p.index, 100), p.root);
  assert.equal(verifyProof(leaf, p.proof, p.index, 100), ledger.find((b) => b.batch === 3).root);
});
