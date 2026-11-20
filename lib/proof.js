'use strict';
/**
 * proof.js — the auditor's answer to one narrow question:
 *
 *   "is THIS one entry inside a batch whose Merkle root was already published?"
 *
 * A batch is 100 leaves. verify.js already knows how to check all 100 at once, but an
 * auditor who was handed a single line of a log should not need the other 99. A Merkle
 * inclusion proof is log2(100) ≈ 7 hashes: enough to rebuild the published root from
 * one leaf, and small enough to paste into an email or a ticket.
 *
 * The leaf we rebuild from is NOT the hash stored next to the entry. It is recomputed
 * from the entry's own fields (lib/store.entryDigest), so an attacker who edits the text
 * of a line and forgets — or "fixes" — the stored hash still fails: the published root
 * was built from the original content and cannot be changed.
 */
require('./env');
const { sha256, merkleRoot, merkleProof, verifyProof, rootFromProof } = require('./merkle');
const store = require('./store');

const short = (h, n = 16) => (typeof h === 'string' && h.length > n ? `${h.slice(0, n)}…` : h);

function entrySummaryOf(entry) {
  return {
    seq: entry.seq,
    ts: entry.ts,
    actor: entry.actor,
    action: entry.action,
    meta: entry.meta || {},
  };
}

/**
 * buildProof(seq) -> proof object, or null when there is nothing to prove
 * (entry not on disk, or entry exists but its batch was never published).
 */
function buildProof(seq) {
  const wanted = Number(seq);
  if (!Number.isInteger(wanted)) return null;

  const rows = store.readLogs();
  const entries = rows.filter((r) => r.ok).map((r) => r.entry);
  const entry = entries.find((e) => e.seq === wanted);
  if (!entry) return null; // deleted, never written, or the line no longer parses

  const batch = store.readLedger().find((b) => wanted >= b.fromSeq && wanted <= b.toSeq);
  if (!batch) return null; // written but not inside any published batch -> nothing to prove against

  // Leaves in published order (by seq). A gap means entries inside this batch are gone,
  // which shifts our leaf position — the rebuilt root will then disagree with the
  // published one. That is the correct outcome: the batch as it stands is not the batch
  // that was anchored.
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const leaves = [];
  const missingSeqs = [];
  for (let s = batch.fromSeq; s <= batch.toSeq; s++) {
    const e = bySeq.get(s);
    if (e) leaves.push(e.hash);
    else missingSeqs.push(s);
  }

  const index = leaves.length ? wanted - batch.fromSeq - missingSeqs.filter((s) => s < wanted).length : -1;
  if (index < 0 || index >= leaves.length) return null;

  // Recompute this entry's leaf from its content + the hash it claims to follow.
  const entryHash = store.entryDigest(entry, entry.prevHash);
  const storedHash = entry.hash;
  const hashMatches = entryHash === storedHash;

  const proofSteps = merkleProof(leaves, index);
  const rebuiltRoot = rootFromProof(index, leaves.length, entryHash, proofSteps);

  // Second proof, against the cumulative checkpoint — this is the root the chain stores,
  // so this is the claim an auditor can check without trusting the operator.
  let checkpointVerified = null;
  let checkpointProofLength = null;
  if (batch.checkpointRoot) {
    const prefix = store
      .readLogs()
      .filter((r) => r.ok && r.entry.seq <= batch.toSeq)
      .map((r) => r.entry.hash);
    const cpIdx = prefix.indexOf(entryHash);
    if (cpIdx >= 0) {
      const cpProof = merkleProof(prefix, cpIdx);
      checkpointProofLength = cpProof.length;
      checkpointVerified = rootFromProof(cpIdx, prefix.length, entryHash, cpProof) === batch.checkpointRoot;
    }
  }
  const recomputedRoot = merkleRoot(leaves);
  const verified = rebuiltRoot === batch.root;

  return {
    seq: wanted,
    entrySummary: entrySummaryOf(entry),
    prevHash: entry.prevHash,
    digestSpec: 'sha256(prevHash|seq|ts|actor|action|JSON.stringify(meta))',
    entryHash,
    storedHash,
    hashMatches,
    batch: batch.batch,
    batchRange: `${batch.fromSeq}-${batch.toSeq}`,
    batchFromSeq: batch.fromSeq,
    batchToSeq: batch.toSeq,
    leafIndex: index,
    leafCount: leaves.length,
    missingSeqs,
    publishedRoot: batch.root,
    recomputedRoot,
    rebuiltRoot,
    checkpointRoot: batch.checkpointRoot || null,
    checkpointVerified,
    checkpointProofLength,
    txHash: batch.txHash,
    chain: batch.chain,
    explorer: batch.explorer || null,
    publishedAt: batch.ts,
    proofSteps: proofSteps.map((s) => ({ side: s.side, hash: s.hash })),
    proofLength: proofSteps.length,
    verified,
    verifiedAt: new Date().toISOString(),
    reason: verified
      ? null
      : !hashMatches
        ? 'entry content no longer matches its stored hash'
        : rebuiltRoot !== batch.root
          ? 'rebuilding the root from this entry does not reproduce the published root'
          : 'unknown',
    algorithm: 'sha256 merkle, odd node duplicated, leaf = store.entryDigest(entry, prevHash)',
    format: 'witness-inclusion-proof/1',
  };
}

function formatProofText(p) {
  if (!p) return 'NO PROOF — entry not found on disk or not inside any published batch.';
  const L = [];
  const rule = '='.repeat(72);
  const s = p.entrySummary;
  L.push(rule);
  L.push('TRACKFOOTS — MERKLE INCLUSION PROOF');
  L.push(rule);
  L.push(`entry          #${s.seq}`);
  L.push(`timestamp      ${s.ts}`);
  L.push(`actor          ${s.actor}`);
  L.push(`action         ${s.action}`);
  L.push(`meta           ${JSON.stringify(s.meta)}`);
  L.push(`prev hash      ${p.prevHash}`);
  L.push(`entry hash     ${p.entryHash}   = ${p.digestSpec}`);
  if (!p.hashMatches) L.push(`stored hash    ${p.storedHash}   <-- MISMATCH: line was altered`);
  L.push('');
  L.push(`batch          ${p.batch}  (seq ${p.batchRange}, ${p.leafCount} leaves on disk)`);
  L.push(`leaf index     ${p.leafIndex}`);
  L.push(`published root ${p.publishedRoot}`);
  L.push(`recomputed     ${p.recomputedRoot}   (merkle root of the batch as it is on disk now)`);
  L.push(`tx             ${p.txHash}`);
  L.push(`chain          ${p.chain}${p.explorer ? `  ${p.explorer}` : ''}`);
  L.push(`published at   ${p.publishedAt}`);
  if (p.missingSeqs.length) L.push(`missing seqs   ${p.missingSeqs.join(', ')}  (deleted from this batch)`);
  L.push('');
  L.push(`PROOF (${p.proofLength} step${p.proofLength === 1 ? '' : 's'}, leaf -> root):`);
  p.proofSteps.forEach((step, i) => {
    L.push(`  ${String(i + 1).padStart(2, ' ')}. ${step.side.padEnd(5)} ${step.hash}`);
  });
  L.push('');
  L.push(`rebuilt root   ${p.rebuiltRoot}`);
  L.push(`published root ${p.publishedRoot}`);
  L.push(`verified       ${p.verified ? 'YES' : 'NO'}   at ${p.verifiedAt}`);
  L.push(rule);
  L.push(
    p.verified
      ? `RESULT: VERIFIED — entry #${p.seq} was inside batch ${p.batch} when its root was published.`
      : `RESULT: FAILED — entry #${p.seq} does not belong to the published root of batch ${p.batch}.`
  );
  if (!p.verified && p.reason) L.push(`reason: ${p.reason}`);
  L.push(rule);
  return L.join('\n');
}

module.exports = { buildProof, formatProofText, short };
