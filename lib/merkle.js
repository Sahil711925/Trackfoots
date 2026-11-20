'use strict';
/**
 * merkle.js — the only "advanced" data structure in this project.
 *
 * A Merkle tree squeezes N fingerprints into 1 fingerprint.
 * If any single input changes, the root changes completely.
 * That single root is the only thing small enough to write to a blockchain.
 */
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Hash N leaves down to one root. Odd node is duplicated (standard trick). */
function merkleRoot(hashes) {
  if (!hashes || hashes.length === 0) return sha256('EMPTY');
  let level = hashes.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/**
 * Prove that ONE leaf belongs to a tree with a given root,
 * without sending the other 999 leaves. That is the proof an auditor needs.
 */
function merkleProof(hashes, index) {
  let level = hashes.slice();
  let idx = index;
  const proof = [];
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push({ hash: level[sibling], side: idx % 2 === 0 ? 'right' : 'left' });
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Rebuild the root from a leaf + its proof. Matches => the leaf is genuine. */
function verifyProof(leafHash, proof) {
  let cur = leafHash;
  for (const step of proof) {
    cur = step.side === 'right' ? sha256(cur + step.hash) : sha256(step.hash + cur);
  }
  return cur;
}

module.exports = { sha256, merkleRoot, merkleProof, verifyProof };
