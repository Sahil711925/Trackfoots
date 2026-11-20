'use strict';
/**
 * ingest.js — the write path a real deployment uses.
 *
 * Everything up to now wrote logs from a seeder or a file importer, which is fine for a demo
 * and useless for a product. This is the endpoint an application actually calls:
 *
 *   POST /api/log        one entry
 *   POST /api/log        {"entries": [...]}  up to 1000
 *
 * The important part is the response: every accepted entry comes back with a **signed receipt**
 * — seq, content hash, and an HMAC tag. That is what the architecture claims: the emitter holds
 * proof of what it wrote, at the moment it wrote it, before any attacker can touch the server.
 */
const store = require('./store');
const receipts = require('./receipts');

const MAX_BATCH = 1000;

function normalise(input) {
  if (!input || typeof input !== 'object') throw new Error('entry must be an object');
  const actor = String(input.actor ?? 'unknown').slice(0, 120);
  const action = String(input.action ?? '').slice(0, 500);
  if (!action) throw new Error('entry.action is required');
  const ts = input.ts ? new Date(input.ts) : new Date();
  if (Number.isNaN(ts.getTime())) throw new Error(`invalid timestamp: ${input.ts}`);
  let meta = input.meta;
  if (meta !== undefined) {
    if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('entry.meta must be an object');
    // keep the stored line bounded; a log line is not a payload store
    if (JSON.stringify(meta).length > 4000) throw new Error('entry.meta is too large (max 4000 bytes)');
  }
  return { ts: ts.toISOString(), actor, action, meta: meta || {} };
}

/**
 * @returns {{ accepted: number, rejected: {index:number, reason:string}[], receipts: object[] }}
 */
function ingest(payload) {
  const raw = Array.isArray(payload) ? payload : payload && Array.isArray(payload.entries) ? payload.entries : [payload];
  if (raw.length === 0) throw new Error('nothing to ingest');
  if (raw.length > MAX_BATCH) throw new Error(`too many entries in one request (max ${MAX_BATCH})`);

  const accepted = [];
  const rejected = [];

  raw.forEach((item, index) => {
    try {
      accepted.push(normalise(item));
    } catch (err) {
      rejected.push({ index, reason: err.message });
    }
  });

  if (accepted.length === 0) {
    return { accepted: 0, rejected, receipts: [] };
  }

  const stamp = Date.now();
  const before = store.readLogs().filter((r) => r.ok).length;
  store.appendMany(accepted);

  // Hand back the receipt for each line we just accepted, keyed by the sequence we assigned.
  const out = [];
  for (let i = 0; i < accepted.length; i++) {
    const seq = before + i + 1;
    const entry = accepted[i];
    const chash = store.contentDigest({ ...entry, seq });
    out.push({ seq, chash, sig: receipts.tagFor({ seq, chash, ts: entry.ts }), sigAlg: 'hmac-sha256', ts: entry.ts });
  }

  return { accepted: accepted.length, rejected, receipts: out, ingestedAt: new Date(stamp).toISOString() };
}

module.exports = { ingest, MAX_BATCH, normalise };
