'use strict';
/**
 * merkle-incremental.test.js — the audit must not get faster by changing what it computes.
 *
 * lib/verify.js derives each checkpoint root from an incremental RFC 6962 accumulator
 * (lib/merkle.js createMerkleAccumulator) instead of rebuilding every prefix from scratch.
 * The on-chain comparison is a byte comparison, so "close enough" is a broken verifier: these
 * tests pin the accumulator to merkleRoot() for every prefix size, pin verify()'s checkpoint
 * verdicts to a naive per-checkpoint recomputation, and pin the tree-shape detail that an
 * obvious "optimisation" would get wrong.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-incremental-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.BATCH_SIZE = '50';

const REPO = path.resolve(__dirname, '..');
const M = require(path.join(REPO, 'lib', 'merkle.js'));
const store = require(path.join(REPO, 'lib', 'store.js'));
const { seed } = require(path.join(REPO, 'lib', 'seed.js'));
const { verify } = require(path.join(REPO, 'lib', 'verify.js'));
const { anchorAll } = require(path.join(REPO, 'scripts', 'anchor.js'));

let logsSnapshot;
let ledgerSnapshot;

before(async () => {
  seed(250); // 5 batches of 50
  const published = await anchorAll({ verbose: false });
  assert.equal(published.length, 5);
  logsSnapshot = fs.readFileSync(store.LOGS, 'utf8');
  ledgerSnapshot = store.readLedger();
});

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

const hashesOf = (n, seedTag) => Array.from({ length: n }, (_, i) => M.sha256(`inc-${seedTag}-${i}`));

/** The naive definition verify() used to compute: root over the prefix of EVERY entry so far. */
function naiveCheckpointMismatches() {
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry).sort((a, b) => a.seq - b.seq);
  return store.readLedger()
    .filter((b) => b.checkpointRoot)
    .filter((b) => {
      const prefix = entries.filter((e) => e.seq <= b.toSeq).map((e) => e.hash);
      return M.merkleRoot(prefix) !== b.checkpointRoot;
    })
    .map((b) => b.batch);
}

// ------------------------------------------------------------------ unit equivalence

test('accumulator root equals merkleRoot() for every prefix size 1..200, three leaf sets', () => {
  for (const tag of ['a', 'b', 'c']) {
    const hashes = hashesOf(200, tag);
    const acc = M.createMerkleAccumulator();
    assert.equal(acc.size(), 0);
    assert.equal(acc.root(), M.merkleRoot([]), 'empty accumulator must be the RFC 6962 empty root');

    for (let k = 1; k <= hashes.length; k++) {
      acc.append(hashes[k - 1]);
      assert.equal(acc.size(), k);
      assert.equal(acc.root(), M.merkleRoot(hashes.slice(0, k)), `leaf set ${tag}: prefix size ${k}`);
    }
  }
});

test('appendAll, one-at-a-time and a fresh accumulator all agree, at tree-shape boundaries', () => {
  // Every size where the frontier gains or loses a level, plus the ranges around them.
  const sizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 511, 512, 1000];
  for (const n of sizes) {
    const hashes = hashesOf(n, `sz${n}`);
    const expected = M.merkleRoot(hashes);
    assert.equal(M.createMerkleAccumulator(hashes).root(), expected, `bulk append at n=${n}`);

    const incremental = M.createMerkleAccumulator();
    for (const h of hashes) incremental.append(h);
    assert.equal(incremental.size(), n);
    assert.equal(incremental.root(), expected, `incremental append at n=${n}`);
  }
});

test('the frontier must fold RIGHT: a left fold is byte-identical only up to 6 leaves', () => {
  // Documented trap. RFC 6962 splits at the largest power of two below n, so for 7 leaves the
  // tail subtree is nested on the right. Folding the frontier left-to-right "looks" equivalent
  // and passes any small-batch test, then diverges — a silent on-chain mismatch.
  const hashes = hashesOf(7, 'fold');
  // Same frontier, opposite fold direction: acc = H(acc, next_subtree) instead of H(next, acc).
  const leftFoldOverFrontier = (leaves) => {
    const stack = []; // perfect subtrees, leftmost first
    for (const h of leaves) {
      let cur = { size: 1, hash: M.leafDigest(h) };
      while (stack.length && stack[stack.length - 1].size === cur.size) {
        const left = stack.pop();
        cur = { size: left.size + cur.size, hash: M.nodeHash(left.hash, cur.hash) };
      }
      stack.push(cur);
    }
    let acc = null;
    for (const s of stack) acc = acc === null ? s.hash : M.nodeHash(acc, s.hash);
    return acc;
  };

  for (let n = 1; n <= 6; n++) {
    assert.equal(leftFoldOverFrontier(hashes.slice(0, n)), M.merkleRoot(hashes.slice(0, n)),
      `left fold coincidentally matches at n=${n}`);
  }
  assert.notEqual(leftFoldOverFrontier(hashes), M.merkleRoot(hashes), 'left fold must differ at n=7');
  assert.equal(M.createMerkleAccumulator(hashes).root(), M.merkleRoot(hashes), 'right fold must match at n=7');
});

// ------------------------------------------------------------------ verify() equivalence

test('every published checkpoint root equals the naive prefix root over the same entries', () => {
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry).sort((a, b) => a.seq - b.seq);
  const ledger = store.readLedger();
  assert.equal(ledger.length, 5, 'fixture needs real checkpoints to compare against');

  for (const batch of ledger) {
    const prefix = entries.filter((e) => e.seq <= batch.toSeq).map((e) => e.hash);
    assert.equal(prefix.length, batch.toSeq, `checkpoint ${batch.batch} covers ${batch.toSeq} entries`);
    assert.equal(batch.checkpointRoot, M.merkleRoot(prefix), `checkpoint ${batch.batch} must recompute`);
  }

  const report = verify();
  assert.deepEqual(report.checkpointMismatches, []);
  assert.equal(report.verdict, 'VERIFIED');
});

test('a tampered middle entry flags exactly the checkpoints a naive recomputation flags', () => {
  const lines = fs.readFileSync(store.LOGS, 'utf8').split('\n').filter(Boolean);
  const victim = 130; // inside batch 3 (seq 101-150)
  const row = JSON.parse(lines[victim - 1]);
  assert.equal(row.seq, victim);
  row.hash = M.sha256('forged-' + row.hash);
  lines[victim - 1] = JSON.stringify(row);
  fs.writeFileSync(store.LOGS, lines.join('\n') + '\n');

  try {
    const expected = naiveCheckpointMismatches();
    const report = verify();
    assert.deepEqual(expected, [3, 4, 5], 'every checkpoint covering the edited entry is bad');
    assert.deepEqual(report.checkpointMismatches, expected, 'incremental pass must agree with naive');
    assert.equal(report.chainOk, false, 'the edit also breaks the hash chain');
  } finally {
    fs.writeFileSync(store.LOGS, logsSnapshot); // restore for the next test
  }
});

test('a ledger listing checkpoints out of order still verifies (slow-path fallback)', () => {
  // Incremental appends assume advancing toSeq. A hand-edited, reordered ledger must fall back
  // to the from-scratch prefix root rather than silently skipping leaves.
  const reversed = [...ledgerSnapshot].reverse();
  fs.writeFileSync(store.LEDGER, reversed.map((b) => JSON.stringify(b)).join('\n') + '\n');
  try {
    const expected = naiveCheckpointMismatches();
    const report = verify();
    assert.deepEqual(expected, [], 'the published roots are still correct for their own prefixes');
    assert.deepEqual(report.checkpointMismatches, []);
    assert.deepEqual(report.badBatches, []);
    assert.equal(report.verdict, 'VERIFIED');
  } finally {
    fs.writeFileSync(store.LEDGER, ledgerSnapshot.map((b) => JSON.stringify(b)).join('\n') + '\n');
  }
});
