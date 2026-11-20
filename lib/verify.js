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
const receiptLib = require('./receipts');
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
    unwitnessedEntries: [],
    checkpointMismatches: [],
    receipts: null,
    receiptKey: null,
    rootCheckMethod: null,
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

  // The predicate is monotone only when the tampering reaches the LAST batch, because a
  // broken hash propagates forward. An attacker who edits one early batch and stops breaks
  // that assumption — so we test it rather than assume it.
  const badFlags = ledger.map(isBad);
  const lastIsBad = badFlags.length > 0 && badFlags[badFlags.length - 1];

  let firstBad = -1;
  if (lastIsBad) {
    // monotone: binary search the first bad batch, O(log n)
    let lo = 0;
    let hi = badFlags.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (badFlags[mid]) hi = mid;
      else lo = mid + 1;
    }
    firstBad = lo;
    report.rootCheckMethod = 'binary-search';
  } else {
    // not monotone (tampering confined to an early batch): scan the flags instead
    firstBad = badFlags.indexOf(true);
    report.rootCheckMethod = firstBad >= 0 ? 'linear-scan' : 'none-needed';
  }

  if (firstBad >= 0) {
    for (let i = firstBad; i < ledger.length; i++) {
      if (!badFlags[i]) continue;
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

  // Entries whose content was never handed to the auditor at write time:
  // content that appeared after the fact, i.e. forged lines.
  const receiptChash = new Set(receipts.map((r) => r.chash));
  for (const [, e] of bySeq) {
    if (e.chash && !receiptChash.has(e.chash)) {
      report.unwitnessedEntries.push({ seq: e.seq, ts: e.ts, action: e.action, hash: e.hash });
    }
  }

  // Content edited in place: the stored content hash no longer matches the line.
  const recomputed = store.contentDigest;
  for (const [, e] of bySeq) {
    if (e.chash && recomputed(e) !== e.chash) {
      report.alteredEntries.push({ seq: e.seq, ts: e.ts, action: e.action, storedChash: e.chash, recomputedChash: recomputed(e) });
    }
  }

  // ---------- 2c. checkpoint check (cumulative) ----------
  // Each ledger row also carries the Merkle root of EVERY entry so far. That is what the
  // chain stores, and what makes consistency proofs possible between checkpoints.
  const ordered = [...bySeq.entries()].sort((a, b) => a[0] - b[0]);
  report.checkpointMismatches = [];
  for (const b of ledger) {
    if (!b.checkpointRoot) continue;
    const prefix = ordered.filter(([s]) => s <= b.toSeq).map(([, e]) => e.hash);
    if (merkleRoot(prefix) !== b.checkpointRoot) report.checkpointMismatches.push(b.batch);
  }

  // ---------- 3. receipt check ----------
  const receiptAuth = { total: receipts.length, valid: 0, invalid: 0, unsigned: 0 };
  for (const r of receipts) {
    const state = receiptLib.verify(r);
    if (state === 'valid') receiptAuth.valid += 1;
    else if (state === 'invalid') receiptAuth.invalid += 1;
    else receiptAuth.unsigned += 1;
  }
  report.receipts = receiptAuth;
  report.receiptKey = receiptLib.status();

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
