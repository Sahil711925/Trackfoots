'use strict';
/**
 * receipt-tree.js — a Merkle commitment over the SET of receipts.
 *
 * A signed receipt proves that one line was witnessed at write time. It does not prove that
 * the set you were handed is the whole set: an attacker who controls the receipt store can
 * drop receipts and every receipt that is left still carries a perfectly valid signature.
 * "All of these are genuine" is a weaker statement than "nothing else exists".
 *
 * This module turns the weaker statement into the stronger one. The receipts are committed
 * to a single RFC 6962 Merkle root, so a verifier can check two things:
 *
 *   completeness  the received receipts, hashed in the documented order, reproduce the root
 *                 that was committed out-of-band. Dropping one receipt changes the root.
 *   inclusion     any single receipt has a short audit path to that same root, so a receipt
 *                 can be shown to belong to the committed set without shipping the set.
 *
 * LEAF CONTENT — fixed, versioned, and used by every caller:
 *
 *     receipt/v1|<seq>|<chash>|<ts>
 *
 * Why that string and not just `chash`: the leaf commits the same three fields the HMAC
 * signature covers (lib/receipts.js `canonical()`), so a receipt cannot be moved to another
 * position, copied with a new timestamp, or paired with different content without breaking
 * the leaf and the signature together. The `receipt/v1|` prefix provides domain separation:
 * an entry leaf is SHA256(0x00 ‖ entryHash), a receipt leaf can never be mistaken for one.
 *
 * ORDER — receipts are sorted by (seq asc, ts asc, chash asc) before hashing, and byte-identical
 * duplicates collapse to one leaf (a repeated append carries no new information, and deduping
 * keeps the root stable when a write is retried). Without a fixed order the root would depend
 * on file order and two honest verifiers would disagree.
 *
 * TRUST NOTE — a root that travels in the same file as the receipts only proves internal
 * consistency; whoever rewrote the receipts can rewrite the root too. Pin the root out-of-band
 * (printed exhibit, chain anchor, a second bundle from a different day) and pass it as
 * `expectRoot`. That is what `scripts/verify-receipts.js --expect-root` is for.
 */
const { merkleRoot, merkleProof, rootFromProof, leafDigest, EMPTY_ROOT } = require('./merkle');

const VERSION = 'receipt/v1';
const SEP = '|';

/** The exact fields a receipt commits, in a fixed order. Same bytes the HMAC signs. */
function canonical(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new TypeError('receipt must be an object');
  const { seq, chash, ts } = receipt;
  if (!Number.isInteger(Number(seq))) throw new TypeError(`receipt has no integer seq: ${seq}`);
  if (typeof chash !== 'string' || !chash) throw new TypeError(`receipt ${seq} has no chash`);
  if (typeof ts !== 'string' || !ts) throw new TypeError(`receipt ${seq} has no ts`);
  return [seq, chash, ts].join(SEP);
}

/** The bytes a leaf commits: versioned, so a receipt leaf is not an entry leaf. */
function leafContent(receipt) {
  return `${VERSION}${SEP}${canonical(receipt)}`;
}

/** Deterministic order. Never rely on file order: a verifier has to reproduce this exactly. */
function order(receipts) {
  const seen = new Set();
  const out = [];
  for (const r of receipts || []) {
    const key = leafContent(r);
    if (seen.has(key)) continue; // byte-identical duplicate: no new information
    seen.add(key);
    out.push(r);
  }
  out.sort((a, b) => {
    const s = Number(a.seq) - Number(b.seq);
    if (s !== 0) return s;
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.chash !== b.chash) return a.chash < b.chash ? -1 : 1;
    return 0;
  });
  return out;
}

/** Leaf hashes in canonical order — the input to every Merkle operation below. */
function leaves(receipts) {
  return order(receipts).map((r) => leafDigest(leafContent(r)));
}

/**
 * buildReceiptRoot(receipts) -> { root, count }
 * `count` is the number of DISTINCT receipts committed, i.e. the size of the tree.
 */
function buildReceiptRoot(receipts) {
  const ordered = order(receipts);
  if (!ordered.length) return { root: EMPTY_ROOT, count: 0 };
  const root = merkleRoot(ordered.map(leafContent));
  return { root, count: ordered.length };
}

/**
 * buildReceiptProof(receipts, target) -> { index, size, root, proof } | null
 * Locate a receipt in the committed set and return its audit path. Matched by leaf content,
 * not by array position, so the caller does not have to know the ordering rule.
 */
function buildReceiptProof(receipts, target) {
  const ordered = order(receipts);
  const key = leafContent(target);
  const index = ordered.findIndex((r) => leafContent(r) === key);
  if (index < 0) return null;
  const contents = ordered.map(leafContent);
  return {
    index,
    size: ordered.length,
    root: merkleRoot(contents),
    proof: merkleProof(contents, index),
  };
}

/**
 * verifyReceiptInclusion(receipt, proof, index, size) -> root hex
 * Rebuilds the root from this one receipt plus its audit path. Returns the recovered root;
 * the caller compares it with the committed root (and should also require `size` to equal
 * the committed count). Throws if the proof does not fit the stated tree shape.
 */
function verifyReceiptInclusion(receipt, proof, index, size) {
  if (!Number.isInteger(index) || !Number.isInteger(size)) {
    throw new Error('verifyReceiptInclusion(receipt, proof, index, size) — index and size are required');
  }
  return rootFromProof(index, size, leafContent(receipt), proof);
}

/**
 * verifyReceiptSet(receipts, { root, count }) -> verdict
 *
 * The completeness check. `root` is what was committed, `count` how many receipts that
 * commitment covered. Both are compared against the receipts actually present.
 */
function verifyReceiptSet(receipts, committed = {}) {
  const expectRoot = committed.root || null;
  const expectCount = Number.isInteger(committed.count) ? committed.count : null;
  let computed;
  try {
    computed = buildReceiptRoot(receipts || []);
  } catch (err) {
    return {
      ok: false,
      present: Array.isArray(receipts) ? receipts.length : 0,
      committed: expectCount,
      root: expectRoot,
      computedRoot: null,
      problem: `receipt set is unreadable: ${err.message}`,
    };
  }

  const present = computed.count;
  const base = {
    present,
    committed: expectCount,
    root: expectRoot,
    computedRoot: computed.root,
  };

  if (!expectRoot) {
    return { ...base, ok: false, problem: 'bundle does not commit a receipt root' };
  }

  if (expectCount !== null && present < expectCount) {
    return {
      ...base,
      ok: false,
      incomplete: true,
      problem: `receipt set is incomplete: ${present} present, ${expectCount} committed`,
    };
  }

  if (expectCount !== null && present > expectCount) {
    return {
      ...base,
      ok: false,
      extra: true,
      problem: `receipt set has more receipts than were committed: ${present} present, ${expectCount} committed`,
    };
  }

  if (computed.root !== expectRoot) {
    return {
      ...base,
      ok: false,
      problem:
        expectCount === null
          ? `receipt set does not reproduce the committed root (${present} receipts)`
          : `receipt set does not reproduce the committed root: ${present} present, ${expectCount} committed`,
    };
  }

  return { ...base, ok: true, problem: null };
}

module.exports = {
  VERSION,
  canonical,
  leafContent,
  order,
  leaves,
  buildReceiptRoot,
  buildReceiptProof,
  verifyReceiptInclusion,
  verifyReceiptSet,
  EMPTY_ROOT,
};
