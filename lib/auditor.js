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
 */
const { sha256, rootFromProof } = require('./merkle');

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

  const verified = checks.every((c) => c.ok !== false);
  return { verified, seq: payload.seq, checks, rebuiltRoot: rebuilt };
}

module.exports = { verifyPayload, entryDigest };
