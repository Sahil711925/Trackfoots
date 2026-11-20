'use strict';
/**
 * anchor.js — publishes one fingerprint per batch.
 *
 * Two modes, chosen by .env:
 *   ANCHOR_ON_CHAIN=false  -> root is written to data/ledger.jsonl (offline demo mode)
 *   ANCHOR_ON_CHAIN=true   -> root is also written to LogAnchor on Polygon Amoy, and the
 *                             ledger stores the real transaction hash
 *
 * The fingerprint is identical in both modes. Only the witness changes.
 */
require('../lib/env');
const { merkleRoot, createMerkleAccumulator, sha256 } = require('../lib/merkle');
const store = require('../lib/store');

let chainLib;
function chainReady() {
  if (String(process.env.ANCHOR_ON_CHAIN || '').toLowerCase() !== 'true') return null;
  try {
    chainLib = chainLib || require('../lib/chain');
    if (!chainLib.readDeployment()) return null;
    return chainLib;
  } catch (err) {
    return null;
  }
}

async function anchorAll({ verbose = true } = {}) {
  const rows = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  const ledger = store.readLedger();
  const alreadyAnchored = new Set(ledger.map((b) => b.batch));
  const total = Math.ceil(rows.length / store.BATCH_SIZE);
  const newBatches = [];

  let prevTx = ledger.length ? ledger[ledger.length - 1].txHash : 'GENESIS';
  const cl = chainReady();

  // Checkpoint roots are cumulative, and each one extends the last. Folding the entries in
  // once, in file order, keeps that prefix state instead of re-hashing every earlier entry
  // per batch (which made anchoring O(batches × entries) — ~48 s for 50k entries).
  const checkpoint = createMerkleAccumulator();
  let checkpointCursor = 0; // entries already folded into `checkpoint`

  for (let b = 1; b <= total; b++) {
    if (alreadyAnchored.has(b)) continue;
    const from = (b - 1) * store.BATCH_SIZE;
    const slice = rows.slice(from, from + store.BATCH_SIZE);
    if (!slice.length) continue;

    // Two roots, on purpose:
    //   root           — a Merkle tree over this batch alone. Gives batch-level granularity,
    //                    so verification can name the exact batch that changed.
    //   checkpointRoot — a Merkle tree over EVERY entry so far. This is the CT-style
    //                    checkpoint, and it is what makes consistency proofs possible:
    //                    checkpoint N+1 must be an extension of checkpoint N.
    const root = merkleRoot(slice.map((e) => e.hash));
    // Skip-ahead is safe: batches already anchored above simply get folded in late, and a
    // prefix of file order is all a checkpoint ever claims.
    while (checkpointCursor < from + slice.length) {
      checkpoint.append(rows[checkpointCursor].hash);
      checkpointCursor += 1;
    }
    const checkpointRoot = checkpoint.root();
    const ts = new Date().toISOString();

    let txHash = '0x' + sha256(prevTx + checkpointRoot + ts + b);
    let chainName = 'LOCAL-SIMULATED';
    let explorer = null;

    if (cl) {
      try {
        const chainSeq = store.runBase() + b;
        // The chain carries the cumulative checkpoint root, not the per-batch one.
        const res = await cl.anchor(checkpointRoot, chainSeq);
        txHash = res.txHash;
        chainName = process.env.CHAIN || 'amoy';
        explorer = cl.explorerUrl(res.txHash);
        if (verbose) console.log(`  batch ${b} mined in block ${res.block} (chain seq ${chainSeq})`);
      } catch (err) {
        if (verbose) console.log(`  batch ${b}: chain write failed (${err.shortMessage || err.message}) — kept local root`);
      }
    }

    prevTx = txHash;
    const batch = {
      batch: b,
      seq: store.runBase() + b,
      fromSeq: slice[0].seq,
      toSeq: slice[slice.length - 1].seq,
      count: slice.length,
      root,
      checkpointRoot,
      ts,
      txHash,
      chain: chainName,
      explorer,
    };
    store.appendLedger(batch);
    newBatches.push(batch);
    if (verbose) {
      console.log(`  anchored batch ${b}  ${batch.fromSeq}-${batch.toSeq}  root ${root.slice(0, 16)}…  tx ${txHash.slice(0, 18)}…`);
    }
  }

  if (verbose) {
    console.log(
      newBatches.length
        ? `published ${newBatches.length} new batch(es) on ${cl ? process.env.CHAIN || 'amoy' : 'local ledger'}`
        : 'nothing new to anchor'
    );
  }
  return newBatches;
}

if (require.main === module) {
  console.log('anchoring…');
  anchorAll().then(() => process.exit(0));
}

module.exports = { anchorAll };
