'use strict';
/**
 * verify.js — the auditor. Answers one question: are these logs genuine?
 *
 * Three independent checks, cheapest first:
 *   1. CHAIN CHECK      each entry's hash must match its own content + the previous hash
 *   2. ROOT CHECK       each batch's Merkle root must match the root we published at the time
 *   3. RECEIPT CHECK    anything the auditor was handed at write time and is now gone was deleted
 *
 * Check 1 catches a lazy attacker. Check 2 catches a careful one, because he cannot
 * change a root that was already published. Check 3 lets us reconstruct the deleted lines.
 */
const { sha256, merkleRoot } = require('./merkle');
const store = require('./store');

function verify() {
  const rows = store.readLogs();
  const ledger = store.readLedger();
  const receipts = store.readReceipts();

  const report = {
    entriesOnDisk: rows.length,
    entriesExpected: receipts.length,
    batchesPublished: ledger.length,
    chainOk: true,
    firstBrokenEntry: null,
    corruptLines: 0,
    missingEntries: [],
    alteredEntries: [],
    badBatches: [],
    verdict: 'VERIFIED',
    checkedAt: new Date().toISOString(),
  };

  // ---------- 1. chain check ----------
  const bySeq = new Map();
  let prevHash = 'GENESIS';
  let runningSeq = 0;

  for (const row of rows) {
    if (!row.ok) {
      report.corruptLines += 1; // unparseable line = someone edited the file badly
      report.chainOk = false;
      continue;
    }
    const e = row.entry;
    runningSeq += 1;
    const expected = store.entryDigest(e, prevHash);
    if (expected !== e.hash) {
      report.chainOk = false;
      if (report.firstBrokenEntry === null) report.firstBrokenEntry = e.seq ?? runningSeq;
    }
    // continue the walk using the stored hash, so a single edit does not mask everything after it
    prevHash = e.hash;
    bySeq.set(e.seq, e);
  }

  // ---------- 2. root check ----------
  // A careful attacker renumbers entries after deleting a block, so a receipt's seq is not
  // a reliable identity. Its HASH is. Match by hash: if the hash still exists anywhere on
  // disk the line survived; if it is gone, it was deleted.
  const diskChash = new Set();
  for (const [, e] of bySeq) if (e.chash) diskChash.add(e.chash);
  const receiptsInRange = (fromSeq, toSeq) => receipts.filter((r) => r.seq >= fromSeq && r.seq <= toSeq);

  const rootOfBatch = (batch) => {
    const leaves = [];
    for (let s = batch.fromSeq; s <= batch.toSeq; s++) {
      const e = bySeq.get(s);
      if (e) leaves.push(e.hash);
    }
    const expectedList = receiptsInRange(batch.fromSeq, batch.toSeq);
    const present = expectedList.filter((r) => diskChash.has(r.chash)).length;
    return { root: merkleRoot(leaves), present, expected: expectedList.length };
  };

  const isBad = (batch) => rootOfBatch(batch).root !== batch.root;

  // Batches are ordered and a break propagates forward (each hash chains the previous),
  // so the predicate is monotone and we can binary-search the first bad batch: O(log n).
  let firstBad = -1;
  if (ledger.length && isBad(ledger[ledger.length - 1])) {
    let lo = 0;
    let hi = ledger.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (isBad(ledger[mid])) hi = mid;
      else lo = mid + 1;
    }
    firstBad = lo;
    for (let i = firstBad; i < ledger.length; i++) {
      if (!isBad(ledger[i])) continue;
      const { root, present, expected } = rootOfBatch(ledger[i]);
      report.badBatches.push({
        batch: ledger[i].batch,
        seqRange: `${ledger[i].fromSeq}-${ledger[i].toSeq}`,
        publishedRoot: ledger[i].root,
        recomputedRoot: root,
        entriesPresent: present,
        entriesExpected: expected,
        txHash: ledger[i].txHash,
        publishedAt: ledger[i].ts,
      });
    }
  }

  // ---------- 3. receipt check ----------
  for (const r of receipts) {
    if (!diskChash.has(r.chash)) {
      report.missingEntries.push({ seq: r.seq, hashSeenAtWriteTime: r.chash, ts: r.ts });
    }
  }

  if (!report.chainOk || report.badBatches.length || report.missingEntries.length) {
    report.verdict = report.badBatches.length || report.missingEntries.length ? 'TAMPERED' : 'CHAIN BROKEN';
  }
  return report;
}

/** Prove one entry is inside a published batch, without shipping the whole batch. */
function proveEntry(seq) {
  const entry = store.readLogs().find((r) => r.ok && r.entry.seq === seq);
  if (!entry) return null;
  const batch = store.readLedger().find((b) => seq >= b.fromSeq && seq <= b.toSeq);
  if (!batch) return null;
  const leaves = [];
  for (let s = batch.fromSeq; s <= batch.toSeq; s++) {
    const e = store.readLogs().find((r) => r.ok && r.entry.seq === s);
    if (e) leaves.push(e.entry.hash);
  }
  const idx = seq - batch.fromSeq;
  return { batch: batch.batch, index: idx, proof: require('./merkle').merkleProof(leaves, idx), root: batch.root, txHash: batch.txHash };
}

module.exports = { verify, proveEntry };
