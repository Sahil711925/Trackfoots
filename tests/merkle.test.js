'use strict';
/**
 * merkle.test.js — unit tests for the hash primitives. Touches no data directory.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const { sha256, merkleRoot, merkleProof, verifyProof } = require(path.join(REPO, 'lib', 'merkle.js'));

test('sha256 is deterministic and matches published NIST vectors', () => {
  // Same input, same digest, every time.
  assert.equal(sha256('abc'), sha256('abc'));
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  // 64 lowercase hex chars.
  assert.match(sha256('witness'), /^[0-9a-f]{64}$/);
  // The module stringifies its input.
  assert.equal(sha256(12345), sha256('12345'));
});

test('sha256 separates inputs that differ by one character', () => {
  assert.notEqual(sha256('batch-3'), sha256('batch-4'));
});

test('merkleRoot is stable for the same leaves and does not mutate its input', () => {
  const leaves = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => sha256(s));
  const copy = leaves.slice();
  const first = merkleRoot(leaves);
  const second = merkleRoot(leaves);
  const third = merkleRoot(copy);

  assert.equal(first, second);
  assert.equal(first, third);
  assert.deepEqual(leaves, copy, 'merkleRoot must not reorder or extend the caller array');
});

test('merkleRoot changes when any single leaf changes', () => {
  const leaves = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => sha256(s));
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const tampered = leaves.slice();
    tampered[i] = sha256('tampered-' + i);
    assert.notEqual(merkleRoot(tampered), root, `changing leaf ${i} must change the root`);
  }
});

test('merkleRoot handles the empty and single-leaf edge cases', () => {
  assert.equal(merkleRoot([]), sha256('EMPTY'));
  assert.equal(merkleRoot(undefined), sha256('EMPTY'));
  const one = sha256('only-leaf');
  assert.equal(merkleRoot([one]), one);
});

test('merkleProof/verifyProof round-trip at every index for odd leaf counts', () => {
  for (const n of [1, 2, 3, 5, 7, 9, 13, 33]) {
    const leaves = Array.from({ length: n }, (_, i) => sha256(`leaf-${n}-${i}`));
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const proof = merkleProof(leaves, i);
      assert.ok(Array.isArray(proof));
      assert.equal(verifyProof(leaves[i], proof), root, `n=${n} index=${i} must rebuild the root`);
    }
  }
});

test('merkleProof/verifyProof round-trip for a full 100-entry batch at every index', () => {
  const leaves = Array.from({ length: 100 }, (_, i) => sha256(`batch-leaf-${i}`));
  const root = merkleRoot(leaves);
  for (let i = 0; i < leaves.length; i++) {
    assert.equal(verifyProof(leaves[i], merkleProof(leaves, i)), root, `index ${i} must verify`);
    assert.ok(merkleProof(leaves, i).length <= 7, 'proof depth for 100 leaves is ceil(log2(100))');
  }
});

test('verifyProof rejects a leaf that is not in the tree and proof tampering', () => {
  const leaves = ['a', 'b', 'c', 'd', 'e'].map((s) => sha256(s));
  const root = merkleRoot(leaves);
  const proof = merkleProof(leaves, 0);

  assert.notEqual(verifyProof(sha256('not-a-leaf'), proof), root);
  assert.notEqual(verifyProof(leaves[1], proof), root);

  const flipped = proof.map((step, i) =>
    i === 0 ? { hash: sha256(step.hash), side: step.side } : step
  );
  assert.notEqual(verifyProof(leaves[0], flipped), root);
});
