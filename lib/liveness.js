'use strict';
/**
 * liveness.js — is the witness still breathing?
 *
 * Tamper-evidence protects the PAST: a published root cannot be rewritten. It says nothing
 * about the PRESENT. An attacker who blocks outbound traffic stops anchoring without touching
 * a single byte of the log — every entry after that point is unwitnessed, and nothing in the
 * verify path notices, because there is nothing to compare against.
 *
 * This module answers three questions from the data on disk (via lib/store, never by opening
 * the files itself):
 *
 *   1. how far has the ledger fallen behind the log?      -> unanchoredEntries
 *   2. how long since the last batch was published?       -> lastAnchorAgeSeconds
 *   3. did the ledger lose a sequence number somewhere?   -> sequenceGaps
 *
 * Anything it cannot answer (no entries yet, no batches yet) is reported as such rather than
 * guessed at.
 *
 * NOTE: no lib/env here on purpose. env.js forces WITNESS_DATA/ANCHOR_ON_CHAIN from .env and
 * would silently redirect a caller that pointed WITNESS_DATA at a different directory.
 */
const store = require('./store');

const DEFAULT_MAX_UNANCHORED = 200;
const DEFAULT_MAX_AGE_SECONDS = 3600;

/**
 * Sequence numbers are `runBase + batch`, and runBase is Date.now() at the first anchor of a
 * run. So within a run the ledger climbs by exactly 1; a new run lands ~1.7e12 higher. A jump
 * bigger than this threshold is a new namespace, not a lost batch.
 */
const NEW_RUN_JUMP = 1000;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pick = (v, fallback) => (isNum(v) ? v : fallback);

/**
 * A ledger row's seq must be exactly previous+1. A jump > NEW_RUN_JUMP means the operator
 * reset into a fresh chain namespace; anything else (duplicate, backwards, or a small forward
 * jump) means a batch record is missing or was reordered — i.e. an anchor went missing.
 */
function findSequenceGaps(ledger) {
  const gaps = [];
  for (let i = 1; i < ledger.length; i++) {
    const prevRow = ledger[i - 1] || {};
    const row = ledger[i] || {};
    const prevSeq = toNum(prevRow.seq);
    const seq = toNum(row.seq);

    if (prevSeq === null || seq === null) {
      gaps.push({
        index: i,
        batch: row.batch ?? null,
        prevBatch: prevRow.batch ?? null,
        prevSeq: prevRow.seq ?? null,
        seq: row.seq ?? null,
        delta: null,
        reason: 'ledger row has no numeric seq',
      });
      continue;
    }

    const delta = seq - prevSeq;
    if (delta === 1) continue;
    if (delta > NEW_RUN_JUMP) continue; // new run namespace — expected after a reset

    gaps.push({
      index: i,
      batch: row.batch ?? null,
      prevBatch: prevRow.batch ?? null,
      prevSeq,
      seq,
      delta,
      reason: delta <= 0
        ? `seq went backwards (${prevSeq} -> ${seq})`
        : `seq skipped ${delta - 1} value(s) (${prevSeq} -> ${seq})`,
    });
  }
  return gaps;
}

/** The batch that got furthest, which is the one that counts as "last published". */
function latestBatch(ledger) {
  let best = null;
  for (const b of ledger) {
    const to = toNum(b && b.toSeq);
    if (to === null) continue;
    if (!best || to >= toNum(best.toSeq)) best = b;
  }
  return best || (ledger.length ? ledger[ledger.length - 1] : null);
}

/**
 * @param {object} [options]
 * @param {number} [options.maxUnanchored=200]   alert above this many unwitnessed entries
 * @param {number} [options.maxAgeSeconds=3600]  alert when the last batch is older than this
 * @param {number} [options.maxEntryAgeSeconds]  "entries keep arriving" window (default: maxAgeSeconds)
 * @param {number} [options.now=Date.now()]      clock override, for tests and demos
 * @returns {object} report
 */
function checkLiveness(options = {}) {
  const maxUnanchored = pick(toNum(options.maxUnanchored), DEFAULT_MAX_UNANCHORED);
  const maxAgeSeconds = pick(toNum(options.maxAgeSeconds), DEFAULT_MAX_AGE_SECONDS);
  const arrivalWindow = pick(toNum(options.maxEntryAgeSeconds), maxAgeSeconds);
  const now = pick(toNum(options.now), Date.now());

  const rows = store.readLogs();
  const ledger = store.readLedger().filter((b) => b && typeof b === 'object');

  const entries = rows.filter((r) => r.ok).map((r) => r.entry);
  const corruptLines = rows.length - entries.length;

  const last = latestBatch(ledger);
  const lastAnchoredSeq = last ? toNum(last.toSeq) ?? 0 : 0;
  const lastAnchorTs = last && last.ts ? last.ts : null;
  const lastAnchorAt = lastAnchorTs ? Date.parse(lastAnchorTs) : NaN;
  const lastAnchorAgeSeconds = Number.isFinite(lastAnchorAt)
    ? Math.max(0, Math.round((now - lastAnchorAt) / 1000))
    : null;

  // Everything past the last published batch is a log entry nobody outside this machine has
  // ever seen a fingerprint of. If there is no ledger at all, that is every entry.
  const pending = entries.filter((e) => {
    const s = toNum(e.seq);
    return s === null ? true : s > lastAnchoredSeq;
  });
  const unanchoredEntries = pending.length;

  let lastEntryAt = null;
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && (lastEntryAt === null || t > lastEntryAt)) lastEntryAt = t;
  }
  const lastEntryAgeSeconds = lastEntryAt === null
    ? null
    : Math.max(0, Math.round((now - lastEntryAt) / 1000));

  const sequenceGaps = findSequenceGaps(ledger);

  // "while entries keep arriving": a quiet system that anchors every few hours is fine, so the
  // age test only fires when there is fresh unwitnessed traffic to protect.
  const entriesArriving = unanchoredEntries > 0
    && (lastEntryAgeSeconds === null || lastEntryAgeSeconds <= arrivalWindow);

  const overUnanchored = unanchoredEntries > maxUnanchored;
  const overAge = lastAnchorAgeSeconds !== null
    && lastAnchorAgeSeconds > maxAgeSeconds
    && entriesArriving;

  const stale = overUnanchored || overAge;
  const reasons = [];
  const notes = [];

  if (overUnanchored) {
    reasons.push(
      `${unanchoredEntries} unanchored entries exceed the limit of ${maxUnanchored} — anchoring has stopped`
    );
  }
  if (overAge) {
    reasons.push(
      `no batch published for ${lastAnchorAgeSeconds}s (limit ${maxAgeSeconds}s) while ${unanchoredEntries} new entr${unanchoredEntries === 1 ? 'y keeps' : 'ies keep'} arriving`
    );
  }
  if (sequenceGaps.length) {
    const first = sequenceGaps[0];
    reasons.push(
      `ledger sequence gap at row ${first.index} (batch ${first.prevBatch ?? '?'} -> ${first.batch ?? '?'}): ${first.reason}`
    );
  }
  if (corruptLines) {
    notes.push(`${corruptLines} unparseable log line(s) were skipped`);
  }
  if (!entries.length) {
    notes.push('no log entries yet — nothing to witness');
  }
  if (!ledger.length && entries.length) {
    notes.push('ledger is empty: no batch has ever been published');
  }
  if (lastAnchorAgeSeconds === null && last) {
    notes.push('last ledger row has no readable timestamp');
  }
  if (!stale && lastAnchorAgeSeconds !== null && !overAge && unanchoredEntries > 0) {
    notes.push(
      `quiet period: ${unanchoredEntries} entr${unanchoredEntries === 1 ? 'y' : 'ies'} pending, newest ${lastEntryAgeSeconds}s old`
    );
  }

  const healthy = !stale && sequenceGaps.length === 0;
  if (healthy) {
    reasons.push(
      lastAnchorAgeSeconds === null
        ? `nothing to anchor yet — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} on disk`
        : `anchoring is live — ${unanchoredEntries} unanchored entr${unanchoredEntries === 1 ? 'y' : 'ies'}, last batch ${lastAnchorAgeSeconds}s ago`
    );
  }

  return {
    checkedAt: new Date(now).toISOString(),
    dataDir: store.DATA,
    totalEntries: entries.length,
    corruptLines,
    anchoredBatches: ledger.length,
    lastBatch: last ? last.batch ?? null : null,
    lastAnchoredSeq,
    lastAnchorTs,
    lastAnchorAgeSeconds,
    unanchoredEntries,
    oldestUnanchoredSeq: pending.length ? toNum(pending[0].seq) : null,
    lastEntryTs: lastEntryAt === null ? null : new Date(lastEntryAt).toISOString(),
    lastEntryAgeSeconds,
    entriesArriving,
    sequenceGaps,
    thresholds: { maxUnanchored, maxAgeSeconds, maxEntryAgeSeconds: arrivalWindow },
    stale,
    healthy,
    reasons,
    notes,
  };
}

module.exports = {
  checkLiveness,
  findSequenceGaps,
  DEFAULT_MAX_UNANCHORED,
  DEFAULT_MAX_AGE_SECONDS,
  NEW_RUN_JUMP,
};
