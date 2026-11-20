'use strict';
/**
 * consistency.js — append-only across time, not just within a batch.
 *
 * Inclusion proves "entry N is inside batch B". It says nothing about whether batch B is
 * still a prefix of batch B+1, which is the gap that lets an operator serve one history to
 * an auditor and a different one to an investigator — each internally consistent.
 *
 * RFC 6962 consistency proofs close that: given two published roots and a short proof, a
 * verifier can confirm the older tree is a strict prefix of the newer one, without trusting
 * the operator and without re-reading the log.
 */
const { consistencyProof, verifyConsistency, merkleRoot, EMPTY_ROOT } = require('./merkle');
const store = require('./store');

/**
 * Check every consecutive pair of published batches.
 * Leaves are taken from disk, which is exactly the point: the verifier recomputes the
 * OLD root from the OLD leaves and the NEW root from the NEW leaves, then checks that
 * the proof links them. A fork fails.
 */
function checkChainOfCheckpoints() {
  const ledger = store.readLedger();
  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry).sort((a, b) => a.seq - b.seq);
  const leaves = entries.map((e) => e.hash);

  if (ledger.length === 0) {
    return { pairs: [], totalPairs: 0, verifiedPairs: 0, ok: true, leaves: 0, note: 'no batches published yet' };
  }

  const pairs = [];
  for (let i = 1; i < ledger.length; i++) {
    const prevBatch = ledger[i - 1];
    const batch = ledger[i];

    const oldSize = entries.filter((e) => e.seq <= prevBatch.toSeq).length;
    const newSize = entries.filter((e) => e.seq <= batch.toSeq).length;

    const oldRoot = prevBatch.checkpointRoot || prevBatch.root;
    const newRoot = batch.checkpointRoot || batch.root;

    let proof = [];
    let verified = false;
    let reason = null;

    try {
      // the prefix of the log as the older checkpoint saw it
      const prefix = leaves.slice(0, newSize);
      const recomputedOld = oldSize === 0 ? EMPTY_ROOT : merkleRoot(prefix.slice(0, oldSize));
      if (recomputedOld !== oldRoot) {
        reason = 'entries for the older checkpoint no longer reproduce its published root';
      } else {
        proof = consistencyProof(prefix, oldSize);
        verified = verifyConsistency(oldSize, newSize, oldRoot, newRoot, proof) && merkleRoot(prefix) === newRoot;
        if (!verified) reason = 'consistency proof does not link the two roots';
      }
    } catch (err) {
      reason = err.message;
    }

    pairs.push({
      from: prevBatch.batch,
      to: batch.batch,
      oldSize,
      newSize,
      oldRoot,
      newRoot,
      proofLength: proof.length,
      verified,
      reason,
    });
  }

  const verifiedPairs = pairs.filter((p) => p.verified).length;
  return {
    pairs,
    totalPairs: pairs.length,
    verifiedPairs,
    ok: verifiedPairs === pairs.length,
    leaves: leaves.length,
    batches: ledger.length,
  };
}

module.exports = { checkChainOfCheckpoints };
