'use strict';
/**
 * auditor.js — verification that does not trust the operator.
 *
 * This module is the answer to "so I still have to trust your server". It receives a bundle
 * (a JSON file produced when the evidence was exported) and checks it against the public
 * chain. It never reads data/, never imports lib/store.js, and never asks the service
 * anything — the only two inputs are the bundle and the chain.
 *
 * If the bundle has been edited, the inclusion proof stops rebuilding the checkpoint root.
 * If the operator published a different root, it will not match the chain.
 *
 * Two independent things are checked about receipts, because they answer different questions:
 *
 *   authenticity  every receipt's HMAC tag verifies under RECEIPT_SECRET, a key held outside
 *                 the server and never derived from anything in data/. A receipt the attacker
 *                 minted for a line that never existed fails here.
 *   completeness  the receipts present reproduce the committed receipt root (lib/receipt-tree).
 *                 An attacker who merely DROPS receipts leaves every remaining signature valid,
 *                 so signature checks alone cannot see the deletion — the root can.
 */
const { sha256, rootFromProof } = require('./merkle');
const receiptsLib = require('./receipts');
const { verifyReceiptSet, verifyReceiptInclusion, buildReceiptProof, order } = require('./receipt-tree');

/** The same digest the server uses, reimplemented here so this module needs none of its code. */
function entryDigest(entry) {
  return sha256(
    [
      entry.prevHash,
      entry.seq,
      entry.ts,
      entry.actor,
      entry.action,
      JSON.stringify(entry.meta || {}),
    ].join('|')
  );
}

/**
 * Check the receipt half of a bundle: signatures, then the set commitment.
 *
 * @param {object} payload  { receipts, receiptRoot, receiptCount, receipt, receiptProof, receiptIndex, receiptSize }
 * @param {object} opts     { verifySignature?: (r) => 'valid'|'invalid'|'unsigned' }
 */
function verifyReceipts(payload, opts = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  if (!payload || (payload.receipts === undefined && payload.receiptRoot === undefined)) {
    return { ok: true, checks, summary: null, present: false };
  }

  const list = Array.isArray(payload.receipts) ? payload.receipts : null;
  const committedRoot = payload.receiptRoot || null;
  const committedCount = Number.isInteger(payload.receiptCount) ? payload.receiptCount : null;

  if (!list) {
    add(
      'receipt list present in the bundle',
      false,
      'the bundle commits a receipt root but carries no receipts, so the set cannot be checked'
    );
    return { ok: false, checks, summary: null, present: true };
  }

  // ---------- authenticity ----------
  const verifySig = typeof opts.verifySignature === 'function' ? opts.verifySignature : receiptsLib.verify;
  const key = receiptsLib.status();
  const tally = { valid: 0, invalid: 0, unsigned: 0 };
  const bad = [];
  for (const r of list) {
    let state;
    try {
      state = verifySig(r);
    } catch (err) {
      state = 'invalid';
    }
    if (state === 'valid') tally.valid += 1;
    else {
      if (state === 'invalid') tally.invalid += 1;
      else tally.unsigned += 1;
      if (bad.length < 5) bad.push(`#${r && r.seq} ${state}`);
    }
  }

  if (!key.persistent && list.length) {
    // No RECEIPT_SECRET here, so this process would be checking tags against its own throwaway
    // key: a failure would say nothing about the bundle. Say that, rather than libelling an
    // honest bundle — and do not call it a pass either.
    add(
      'every receipt signature is valid',
      null,
      `not checked — no RECEIPT_SECRET in this environment, so receipts signed elsewhere cannot be judged (${list.length} present)`
    );
  } else {
    add(
      'every receipt signature is valid',
      tally.invalid === 0 && tally.unsigned === 0,
      `${tally.valid} valid${tally.invalid ? `, ${tally.invalid} invalid` : ''}${
        tally.unsigned ? `, ${tally.unsigned} unsigned` : ''
      }${bad.length ? ` — ${bad.join(', ')}` : ''} (key: ${key.keySource})`
    );
  }

  // ---------- completeness ----------
  const set = verifyReceiptSet(list, { root: committedRoot, count: committedCount });
  add(
    'receipt set reproduces the committed receipt root',
    set.ok,
    set.ok ? `${set.present} receipt(s) → ${String(set.computedRoot).slice(0, 24)}…` : set.problem
  );

  // ---------- inclusion, when the bundle carries one receipt's audit path ----------
  if (payload.receiptProof) {
    try {
      const recovered = verifyReceiptInclusion(
        payload.receipt,
        payload.receiptProof,
        Number(payload.receiptIndex),
        Number(payload.receiptSize === undefined ? committedCount : payload.receiptSize)
      );
      add(
        'receipt inclusion proof rebuilds the receipt root',
        recovered === committedRoot,
        `${String(recovered).slice(0, 16)}… vs committed ${String(committedRoot).slice(0, 16)}…`
      );
    } catch (err) {
      add('receipt inclusion proof rebuilds the receipt root', false, err.message);
    }
  }

  return {
    ok: checks.every((c) => c.ok !== false),
    checks,
    present: true,
    summary: {
      present: set.present,
      committed: set.committed,
      root: set.root,
      computedRoot: set.computedRoot,
      signatures: tally,
      keySource: key.keySource,
      persistentKey: key.persistent,
      problem: set.problem,
    },
  };
}

/**
 * @param {object} payload  { seq, size, index, entry, entryHash, proofSteps, checkpointRoot, checkpointTx }
 * @param {object} opts     { readChainRoot?: async (seq) => hex }
 */
async function verifyPayload(payload, opts = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  if (!payload || !payload.entry) {
    return { verified: false, checks: [{ name: 'bundle', ok: false, detail: 'no entry in bundle' }] };
  }

  const entry = payload.entry;
  const index = Number(payload.index);
  const size = Number(payload.size);
  const proof = payload.proofSteps || [];

  const recomputed = entryDigest(entry);
  add('entry digest', recomputed === payload.entryHash, `${recomputed.slice(0, 16)}… vs bundle ${String(payload.entryHash).slice(0, 16)}…`);

  let rebuilt = null;
  try {
    rebuilt = rootFromProof(index, size, recomputed, proof);
    add('inclusion proof rebuilds the checkpoint root', rebuilt === payload.checkpointRoot,
      rebuilt ? `${rebuilt.slice(0, 16)}… vs ${String(payload.checkpointRoot).slice(0, 16)}…` : 'proof failed');
  } catch (err) {
    add('inclusion proof rebuilds the checkpoint root', false, err.message);
  }

  if (typeof opts.readChainRoot === 'function') {
    try {
      const onChain = await opts.readChainRoot(payload.chainSeq ?? payload.seq);
      const bare = (h) => String(h || '').toLowerCase().replace(/^0x/, '');
      const match = onChain && bare(onChain) === bare(payload.checkpointRoot);
      add('checkpoint root matches the chain', match,
        onChain ? `chain ${bare(onChain).slice(0, 16)}…` : 'no root at that sequence on the chain');
    } catch (err) {
      add('checkpoint root matches the chain', false, `chain read failed: ${err.shortMessage || err.message}`);
    }
  } else {
    add('checkpoint root matches the chain', null, 'not checked — no chain access in this run');
  }

  // The receipt half. Bundles exported before receipt commitment existed carry neither field,
  // in which case there is nothing to check and nothing is claimed.
  const receiptResult = verifyReceipts(payload, opts);
  for (const c of receiptResult.checks) checks.push(c);

  const verified = checks.every((c) => c.ok !== false);
  return {
    verified,
    seq: payload.seq,
    checks,
    rebuiltRoot: rebuilt,
    receipts: receiptResult.summary,
  };
}

module.exports = { verifyPayload, verifyReceipts, entryDigest, buildReceiptProof, order };
