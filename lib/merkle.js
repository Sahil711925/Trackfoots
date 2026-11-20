'use strict';
/**
 * merkle.js — Merkle tree with RFC 6962 (Certificate Transparency) semantics.
 *
 * Why the standard matters here: a reviewer who knows the field will ask "is this a real
 * transparency log, or just hashing pairs?" RFC 6962 fixes three things a naive
 * implementation gets wrong:
 *
 *   1. Domain separation. Leaves are SHA256(0x00 ‖ data), nodes are SHA256(0x01 ‖ l ‖ r).
 *      Without the prefix bytes a crafted interior node can be passed off as a leaf.
 *   2. The empty tree has a defined root: SHA256() over no bytes — not a sentinel string.
 *   3. Subtrees split at the largest power of two below n. They do NOT duplicate the last
 *      node, which would make different trees produce the same root.
 *
 * The tree is built over log-entry hashes; a leaf digest is SHA256(0x00 ‖ entryHash).
 */
const crypto = require('crypto');

const EMPTY_ROOT = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function bytesOf(data) {
  if (Buffer.isBuffer(data)) return data;
  const s = String(data);
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  return Buffer.from(s, 'utf8');
}

/** SHA256(0x00 ‖ data) — RFC 6962 leaf hash. */
function leafDigest(data) {
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), bytesOf(data)])).digest('hex');
}

/** SHA256(0x01 ‖ left ‖ right) — RFC 6962 interior node. */
function nodeHash(left, right) {
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x01]), Buffer.from(left, 'hex'), Buffer.from(right, 'hex')]))
    .digest('hex');
}

/** Largest power of two strictly less than n. */
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH over already-computed leaf digests. */
function mth(leafDigests) {
  const n = leafDigests.length;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leafDigests[0];
  const k = splitPoint(n);
  return nodeHash(mth(leafDigests.slice(0, k)), mth(leafDigests.slice(k)));
}

/** Public: root over an array of entry hashes. */
function merkleRoot(hashes) {
  return mth((hashes || []).map(leafDigest));
}

/**
 * Incremental RFC 6962 accumulator (the "frontier" structure).
 *
 * Rebuilding a root from scratch for every checkpoint is what makes an audit quadratic: with
 * B checkpoints over N entries that is B prefix roots, each hashing O(prefix) leaves. This
 * keeps the leaves it has already hashed instead. Each append merges at most O(log n) perfect
 * subtrees, so the whole run of checkpoint roots costs O(n log n) once, and a single root
 * costs O(log n) to report.
 *
 * The root for k leaves is byte-identical to merkleRoot(hashes.slice(0, k)). That constrains
 * the fold direction, and it is easy to get wrong:
 *
 *   The frontier holds the binary decomposition of k into perfect subtrees, leftmost first
 *   (sizes 4,2,1 for k=7). RFC 6962 splits at the largest power of two BELOW n, so
 *   MTH(D[7]) = H(MTH(D[0:4]), MTH(D[4:7])) and MTH(D[4:7]) = H(MTH(D[4:6]), MTH(D[6])).
 *   The subtrees therefore combine as a RIGHT fold — node(left_subtree, acc) — walking the
 *   frontier from the rightmost/smallest inward. Folding left, root = H(acc, next), is the
 *   obvious-looking alternative and it disagrees with merkleRoot() from k = 7 upward, which
 *   would silently break every on-chain comparison while looking correct for small batches.
 *
 * `append` takes an entry hash (as merkleRoot does), not a pre-computed leaf digest, so a
 * caller cannot skip domain separation.
 */
function createMerkleAccumulator(initialHashes) {
  const stack = []; // perfect subtrees: leftmost/largest first, rightmost/smallest last
  let count = 0;

  function append(hash) {
    let cur = { size: 1, hash: leafDigest(hash) };
    // The frontier is ordered left to right, so an equal-sized neighbour is the LEFT child.
    while (stack.length && stack[stack.length - 1].size === cur.size) {
      const left = stack.pop();
      cur = { size: left.size + cur.size, hash: nodeHash(left.hash, cur.hash) };
    }
    stack.push(cur);
    count += 1;
    return count;
  }

  function appendAll(hashes) {
    for (const h of hashes || []) append(h);
    return count;
  }

  /** MTH of the leaves appended so far. */
  function root() {
    if (count === 0) return EMPTY_ROOT;
    let acc = stack[stack.length - 1].hash; // rightmost, smallest subtree
    for (let i = stack.length - 2; i >= 0; i--) acc = nodeHash(stack[i].hash, acc);
    return acc;
  }

  if (initialHashes) appendAll(initialHashes);

  return { append, appendAll, root, size: () => count };
}

/** PATH(m, D[n]) — audit path for one leaf, as {hash, side} steps in RFC order. */
function merkleProof(hashes, index) {
  const leaves = (hashes || []).map(leafDigest);
  if (index < 0 || index >= leaves.length) throw new Error(`leaf index ${index} out of range`);

  function path(m, D) {
    const n = D.length;
    if (n <= 1) return [];
    const k = splitPoint(n);
    if (m < k) return path(m, D.slice(0, k)).concat([{ hash: mth(D.slice(k)), side: 'right' }]);
    return path(m - k, D.slice(k)).concat([{ hash: mth(D.slice(0, k)), side: 'left' }]);
  }
  return path(index, leaves);
}

/**
 * Rebuild the root from a leaf's ORIGINAL data plus its proof.
 * Takes the entry hash, not the leaf digest, so a caller cannot skip domain separation.
 * `index` and `size` are required: under RFC 6962 the tree shape cannot be inferred
 * from the proof alone.
 */
function rootFromProof(index, size, leafData, proof) {
  const stack = (proof || []).slice();
  const leaf = leafDigest(leafData);

  // The proof is ordered innermost-sibling-first, outermost-sibling-last, so the top-level
  // sibling must be popped BEFORE recursing into the child.
  function build(m, n) {
    if (n === 1) return leaf;
    const k = splitPoint(n);
    const step = stack.pop();
    if (!step) throw new Error('proof too short');
    const sibling = typeof step === 'string' ? step : step.hash;
    if (m < k) return nodeHash(build(m, k), sibling);
    return nodeHash(sibling, build(m - k, n - k));
  }

  const root = build(index, size);
  if (stack.length) throw new Error('proof too long');
  return root;
}

/** Backwards-compatible wrapper. */
function verifyProof(leafData, proof, index, size) {
  if (!Number.isInteger(index) || !Number.isInteger(size)) {
    throw new Error('verifyProof(leafData, proof, index, size) — index and size are required');
  }
  return rootFromProof(index, size, leafData, proof);
}

/**
 * PROOF(m, D[n]) — proof that a tree of size m is a prefix of a tree of size n.
 * This is what stops an operator serving one history to an auditor and a different one
 * to an investigator: the older root must provably be a prefix of the newer root.
 */
function consistencyProof(hashes, oldSize) {
  const leaves = (hashes || []).map(leafDigest);
  const n = leaves.length;
  const m = oldSize;
  if (!Number.isInteger(m) || m < 0 || m > n) throw new Error(`old size ${m} outside 0..${n}`);
  if (m === 0 || m === n) return [];

  function subproof(mm, D, b) {
    const size = D.length;
    if (mm === size) return b ? [] : [mth(D)];
    const k = splitPoint(size);
    if (mm <= k) return subproof(mm, D.slice(0, k), b).concat([mth(D.slice(k))]);
    return subproof(mm - k, D.slice(k), false).concat([mth(D.slice(0, k))]);
  }
  return subproof(m, leaves, true);
}

/** Verify a consistency proof (RFC 6962 §2.1.3, following the Go reference). */
function verifyConsistency(oldSize, newSize, oldRoot, newRoot, proof) {
  if (oldSize < 0 || oldSize > newSize) return false;
  if (oldSize === newSize) return (proof || []).length === 0 && oldRoot === newRoot;
  if (oldSize === 0) return (proof || []).length === 0 && oldRoot === EMPTY_ROOT;

  let node = oldSize - 1;
  let lastNode = newSize - 1;
  while (node % 2 === 1) {
    node = Math.floor(node / 2);
    lastNode = Math.floor(lastNode / 2);
  }

  const p = (proof || []).slice();
  let seed;
  if (node > 0) {
    seed = p.shift();
    if (!seed) return false;
  } else {
    seed = oldRoot;
  }

  let hash1 = seed;
  let hash2 = seed;

  for (; node > 0; node = Math.floor(node / 2), lastNode = Math.floor(lastNode / 2)) {
    if (node % 2 === 1) {
      const sib = p.shift();
      if (!sib) return false;
      hash1 = nodeHash(sib, hash1);
      hash2 = nodeHash(sib, hash2);
    } else if (node < lastNode) {
      const sib = p.shift();
      if (!sib) return false;
      hash2 = nodeHash(hash2, sib);
    }
  }

  for (; lastNode > 0; lastNode = Math.floor(lastNode / 2)) {
    const sib = p.shift();
    if (!sib) return false;
    hash2 = nodeHash(hash2, sib);
  }

  return p.length === 0 && hash1 === oldRoot && hash2 === newRoot;
}

module.exports = {
  sha256,
  leafDigest,
  nodeHash,
  merkleRoot,
  createMerkleAccumulator,
  merkleProof,
  verifyProof,
  rootFromProof,
  consistencyProof,
  verifyConsistency,
  EMPTY_ROOT,
  splitPoint,
};
