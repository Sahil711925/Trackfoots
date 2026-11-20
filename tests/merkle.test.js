'use strict';
/**
 * merkle.test.js — RFC 6962 (Certificate Transparency) conformance.
 *
 * These tests are written against the specification, not against the implementation:
 * every expected value is computed here from the RFC's own formulas, with prefixes and
 * split points spelled out, so a change in lib/merkle.js cannot quietly redefine what
 * "correct" means.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');
const M = require(path.join(REPO, 'lib', 'merkle.js'));

const H = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const leaf = (s) => H(Buffer.concat([Buffer.from([0x00]), Buffer.from(s, 'hex')]));
const node = (l, r) => H(Buffer.concat([Buffer.from([0x01]), Buffer.from(l, 'hex'), Buffer.from(r, 'hex')]));

function leavesOf(n, seed = 1) {
  return Array.from({ length: n }, (_, i) => H(Buffer.from(`leaf-${seed}-${i}`)));
}

test('empty tree has the RFC 6962 root: SHA256 over no bytes', () => {
  assert.equal(M.merkleRoot([]), H(Buffer.alloc(0)), 'MTH({}) must be SHA256()');
  assert.equal(M.merkleRoot([]), M.EMPTY_ROOT);
  // and it must NOT be a sentinel hash of a string like "EMPTY"
  assert.notEqual(M.merkleRoot([]), crypto.createHash('sha256').update('EMPTY').digest('hex'));
});

test('single leaf root equals SHA256(0x00 ‖ leaf)', () => {
  const L = leavesOf(1);
  assert.equal(M.merkleRoot(L), leaf(L[0]));
});

test('domain separation: a leaf and an interior node can never collide', () => {
  const L = leavesOf(2);
  // the naive "no prefixes" construction would produce node(logical) == leaf-ish values
  assert.notEqual(M.leafDigest(L[0]), M.nodeHash(L[0], L[1]));
  // hashing the same bytes as a leaf and as a node must differ
  assert.notEqual(M.leafDigest(L[0] + L[1]), M.nodeHash(L[0], L[1]));
});

test('subtrees split at the largest power of two below n (no duplication)', () => {
  const L = leavesOf(5);
  assert.equal(M.splitPoint(2), 1);
  assert.equal(M.splitPoint(3), 2);
  assert.equal(M.splitPoint(4), 2);
  assert.equal(M.splitPoint(5), 4);
  assert.equal(M.splitPoint(100), 64);

  const n3 = node(node(leaf(L[0]), leaf(L[1])), leaf(L[2]));
  assert.equal(M.merkleRoot(L.slice(0, 3)), n3, '3 leaves must be 2|1, not 2|(2 duplicated)');

  const n4 = node(node(leaf(L[0]), leaf(L[1])), node(leaf(L[2]), leaf(L[3])));
  assert.equal(M.merkleRoot(L.slice(0, 4)), n4);

  const n5 = node(n4, leaf(L[4]));
  assert.equal(M.merkleRoot(L.slice(0, 5)), n5, '5 leaves must be 4|1');
});

test('inclusion proof round-trips at every index, every size 1..40', () => {
  for (let n = 1; n <= 40; n++) {
    const L = leavesOf(n, n);
    const root = M.merkleRoot(L);
    for (let i = 0; i < n; i++) {
      const proof = M.merkleProof(L, i);
      assert.equal(M.rootFromProof(i, n, L[i], proof), root, `n=${n} i=${i}`);
      assert.equal(M.verifyProof(L[i], proof, i, n), root, `n=${n} i=${i} (wrapper)`);
    }
  }
});

test('a 100-leaf batch proves every position and rebuilds the published root', () => {
  const L = leavesOf(100, 7);
  const root = M.merkleRoot(L);
  for (let i = 0; i < 100; i++) {
    const proof = M.merkleProof(L, i);
    assert.equal(M.rootFromProof(i, 100, L[i], proof), root, `index ${i}`);
    assert.ok(proof.length >= 4 && proof.length <= 7, `path length ${proof.length} at ${i}`);
    for (const step of proof) assert.ok(step.side === 'left' || step.side === 'right');
  }
});

test('tampered proofs are rejected', () => {
  const L = leavesOf(11, 3);
  const proof = M.merkleProof(L, 3);
  const other = leavesOf(11, 4)[3];

  assert.notEqual(M.rootFromProof(3, 11, other, proof), M.merkleRoot(L), 'wrong leaf must not rebuild the root');

  const flipped = proof.map((s, k) => (k === 0 ? { ...s, hash: s.hash.slice(0, -1) + (s.hash.endsWith('0') ? '1' : '0') } : s));
  assert.notEqual(M.rootFromProof(3, 11, L[3], flipped), M.merkleRoot(L), 'mutated sibling must fail');

  assert.throws(() => M.rootFromProof(3, 11, L[3], proof.slice(1)), /proof too short/);
  assert.throws(() => M.rootFromProof(3, 11, L[3], proof.concat(['00'.repeat(32)])), /proof too long/);
});

test('consistency proof round-trips for every m <= n <= 40', () => {
  for (let n = 1; n <= 40; n++) {
    const L = leavesOf(n, 200 + n);
    const newRoot = M.merkleRoot(L);
    for (let m = 0; m <= n; m++) {
      const oldRoot = m === 0 ? M.EMPTY_ROOT : M.merkleRoot(L.slice(0, m));
      const proof = M.consistencyProof(L, m);
      assert.equal(M.verifyConsistency(m, n, oldRoot, newRoot, proof), true, `m=${m} n=${n}`);
    }
  }
});

test('consistency rejects a forked history and a foreign old root', () => {
  const L = leavesOf(20, 9);
  const proof = M.consistencyProof(L, 19);
  const oldRoot = M.merkleRoot(L.slice(0, 19));

  assert.equal(M.verifyConsistency(19, 20, oldRoot, M.merkleRoot(L), proof), true);

  const forked = L.slice(0, 19).concat([H(Buffer.from('forged'))]);
  assert.equal(M.verifyConsistency(19, 20, oldRoot, M.merkleRoot(forked), proof), false, 'fork must fail');

  const foreign = leavesOf(20, 10);
  assert.equal(M.verifyConsistency(19, 20, M.merkleRoot(foreign.slice(0, 19)), M.merkleRoot(L), proof), false,
    'old root from another tree must fail');
});

test('consistency edge cases', () => {
  const L = leavesOf(8, 5);
  assert.deepEqual(M.consistencyProof(L, 8), [], 'same size needs no proof');
  assert.deepEqual(M.consistencyProof(L, 0), [], 'empty tree needs no proof');
  assert.equal(M.verifyConsistency(0, 8, M.EMPTY_ROOT, M.merkleRoot(L), []), true);
  assert.equal(M.verifyConsistency(5, 4, 'x', 'y', []), false, 'old > new is invalid');
});
