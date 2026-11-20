'use strict';
/**
 * consistency.test.js — the append-only property, end to end.
 *
 * Inclusion says "this entry is in that batch". Consistency says "the checkpoint the chain
 * holds today extends the checkpoint it held yesterday" — the difference between
 * tamper-evident and fork-evident.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-consistency-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { seed } = require(path.join(REPO, 'lib', 'seed.js'));
const { anchorAll } = require(path.join(REPO, 'scripts', 'anchor.js'));
const { checkChainOfCheckpoints } = require(path.join(REPO, 'lib', 'consistency.js'));
const { merkleRoot } = require(path.join(REPO, 'lib', 'merkle.js'));

before(async () => {
  store.ensure();
  seed(500);
  await anchorAll({ verbose: false });
});

after(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('every ledger row carries both a batch root and a cumulative checkpoint root', () => {
  const ledger = store.readLedger();
  assert.equal(ledger.length, 5, '500 entries at 100 per batch');
  for (const b of ledger) {
    assert.match(b.root, /^[0-9a-f]{64}$/);
    assert.match(b.checkpointRoot, /^[0-9a-f]{64}$/);
    if (b.batch > 1) assert.notEqual(b.root, b.checkpointRoot, 'from batch 2 on the two roots differ');
  }
  // the first batch is its own checkpoint
  assert.equal(ledger[0].root, ledger[0].checkpointRoot);
});

test('the checkpoint root really is the root of all entries so far', () => {
  const ledger = store.readLedger();
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry).sort((a, b) => a.seq - b.seq);
  for (const b of ledger) {
    const prefix = entries.filter((e) => e.seq <= b.toSeq).map((e) => e.hash);
    assert.equal(merkleRoot(prefix), b.checkpointRoot, `checkpoint for batch ${b.batch}`);
  }
});

test('every consecutive checkpoint pair verifies as an extension', () => {
  const r = checkChainOfCheckpoints();
  assert.equal(r.totalPairs, 4, '5 batches give 4 pairs');
  assert.equal(r.verifiedPairs, 4);
  assert.equal(r.ok, true);
  for (const p of r.pairs) {
    assert.equal(p.verified, true, `pair ${p.from}->${p.to}: ${p.reason || ''}`);
    assert.ok(p.proofLength > 0, 'a real extension needs a non-empty proof');
  }
});

test('rewriting history breaks the append-only property', () => {
  const { attack } = require(path.join(REPO, 'lib', 'attack.js'));

  // The careful attacker rewrites content AND recomputes every hash, so the entries stay
  // self-consistent. Only the checkpoint roots can catch it.
  attack('smart', 1);
  const broken = checkChainOfCheckpoints();
  assert.equal(broken.ok, false, 'a rewritten history must break append-only');
  assert.ok(broken.pairs.some((p) => !p.verified), 'at least one checkpoint pair must fail');

  // Restore: wipe and rebuild the fixture so later assertions are unaffected.
  fs.rmSync(DATA, { recursive: true, force: true });
  store.ensure();
  seed(500);
  return anchorAll({ verbose: false }).then(() => {
    assert.equal(checkChainOfCheckpoints().ok, true, 'a clean rebuild verifies again');
  });
});
