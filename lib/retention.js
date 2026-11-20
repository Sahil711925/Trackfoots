'use strict';
/**
 * retention.js — CERT-In's 180-day duty, measured instead of asserted.
 *
 * The README says "keep security logs for 180 days". Until now nothing in the code knew
 * that number. This module answers three questions an auditor actually asks:
 *
 *   1. HOW MUCH HISTORY DO WE HOLD?   -> retentionReport(): counts, cutoff, age, per-day histogram
 *   2. WHAT WOULD RETENTION DESTROY?  -> pruneExpired({ dryRun: true }) (the default)
 *   3. MAY IT DESTROY IT?             -> pruneExpired({ dryRun: false }) refuses when the
 *                                        entries are covered by a published batch
 *
 * Rule 3 is the whole point. Under a hash-chained log, deleting an entry that sits inside a
 * published Merkle root does not remove evidence — it destroys the operator's ability to
 * reproduce a root that is already on a public ledger. So deletion is opt-in, blocked by
 * anchored data, and every real prune leaves a tombstone recording exactly what went.
 *
 * compliant = "no entry on disk has aged past the policy boundary". An entry older than the
 * cutoff is expired, and expired data awaiting destruction is a retention failure, not a
 * bonus. That is the condition the CLI exits 3 on.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { sha256, merkleRoot } = require('./merkle');

const DEFAULT_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE = path.join(store.DATA, 'retention.jsonl');

/** Age in ms -> the shortest honest human label: 45m, 13h, 2d. */
function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const utcDay = (iso) => String(iso).slice(0, 10);
const round = (n, p) => Number(n.toFixed(p));

function checkDays(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`retention: days must be a positive number, got ${days}`);
  return d;
}

function toDate(now) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error(`retention: invalid now value ${now}`);
  return d;
}

/** Parseable timestamp -> ms, else null. An unreadable ts is never treated as expired:
 *  destroying an entry because we could not read its clock would be indefensible. */
function tsOf(entry) {
  const t = Date.parse(entry && entry.ts);
  return Number.isNaN(t) ? null : t;
}

/**
 * retentionReport({ days, now }) — the state of the store against the policy.
 * perDay holds only days that actually have entries, oldest first.
 */
function retentionReport({ days = DEFAULT_DAYS, now = new Date() } = {}) {
  const policyDays = checkDays(days);
  const nowDate = toDate(now);
  const nowMs = nowDate.getTime();
  const cutoffMs = nowMs - policyDays * DAY_MS;
  const cutoffISO = new Date(cutoffMs).toISOString();

  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  const dated = [];
  let undated = 0;
  for (const e of entries) {
    const t = tsOf(e);
    if (t === null) undated += 1;
    else dated.push({ entry: e, t });
  }

  const expired = dated.filter((d) => d.t < cutoffMs).length;
  const dayCounts = new Map();
  for (const d of dated) {
    const key = utcDay(d.entry.ts);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  }
  const perDay = [...dayCounts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count }));

  let oldestMs = null;
  let newestMs = null;
  for (const d of dated) {
    if (oldestMs === null || d.t < oldestMs) oldestMs = d.t;
    if (newestMs === null || d.t > newestMs) newestMs = d.t;
  }

  return {
    policyDays,
    cutoffISO,
    totalEntries: entries.length,
    inPolicy: entries.length - expired,
    expired,
    oldestISO: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    newestISO: newestMs === null ? null : new Date(newestMs).toISOString(),
    perDay,
    compliant: expired === 0,
    oldestAgeDays: oldestMs === null ? 0 : round((nowMs - oldestMs) / DAY_MS, 2),
    undated,
    generatedAt: nowDate.toISOString(),
  };
}

/** One line for a UI banner. */
function retentionStatus({ days = DEFAULT_DAYS, now = new Date() } = {}) {
  const r = retentionReport({ days, now });
  const head = `${r.policyDays}-day policy`;
  if (r.totalEntries === 0) return `${head} · no entries · compliant`;
  const oldest = formatAge((Date.parse(r.generatedAt) || Date.now()) - Date.parse(r.oldestISO));
  return r.compliant
    ? `${head} · oldest ${oldest} · compliant`
    : `${head} · oldest ${oldest} · ${r.expired} past cutoff`;
}

/**
 * pruneExpired({ days, dryRun = true, now }) -> { removed, kept, cutoffISO, dryRun, ... }
 *
 * dryRun is the default on purpose: the safe call must be the one you get for free.
 *
 * Anchored data is immortal. If any entry that would be removed lies inside a published
 * batch, a real prune throws RETENTION_BLOCKED, because the batch root and the cumulative
 * checkpoint root are what an auditor uses to prove inclusion after the fact — deleting
 * the leaves leaves a root nobody can reproduce. A dry run reports the same block in its
 * return value instead of throwing, so the UI can show it.
 */
function pruneExpired({ days = DEFAULT_DAYS, dryRun = true, now = new Date() } = {}) {
  const report = retentionReport({ days, now });
  const cutoffMs = Date.parse(report.cutoffISO);
  const rows = store.readLogs();
  const lines = store.readLines(store.LOGS);

  const isExpired = (row) => {
    if (!row.ok) return false; // an unparseable line is evidence, not garbage — keep it
    const t = tsOf(row.entry);
    return t !== null && t < cutoffMs;
  };

  const expiredRows = [];
  rows.forEach((row, i) => { if (isExpired(row)) expiredRows.push({ row, i }); });

  const expiredSeqs = expiredRows.map(({ row }) => row.entry.seq);
  const ledger = store.readLedger();
  const anchoredSeqs = new Set();
  const batchHits = [];
  for (const b of ledger) {
    const hit = expiredSeqs.filter((s) => s >= b.fromSeq && s <= b.toSeq);
    for (const s of hit) anchoredSeqs.add(s);
    if (hit.length > 0) batchHits.push({ batch: b.batch, seqRange: `${b.fromSeq}-${b.toSeq}`, entries: hit.length, txHash: b.txHash });
  }
  const blocked = batchHits.length > 0;
  const reason = blocked
    ? `${expiredSeqs.length} expired entr${expiredSeqs.length === 1 ? 'y falls' : 'ies fall'} inside published ` +
      `batch(es) ${batchHits.map((b) => b.batch).join(', ')}. Those leaves are needed to reproduce a Merkle root ` +
      'that is already anchored, so deleting them would destroy evidence rather than expire it.'
    : null;

  const base = {
    removed: expiredRows.length,
    kept: rows.length - expiredRows.length,
    cutoffISO: report.cutoffISO,
    dryRun: Boolean(dryRun),
    blocked,
    reason,
    batches: batchHits,
  };

  if (dryRun) {
    return {
      ...base,
      candidates: expiredRows.map(({ row }) => ({
        seq: row.entry.seq,
        ts: row.entry.ts,
        actor: row.entry.actor,
        action: row.entry.action,
        anchored: anchoredSeqs.has(row.entry.seq),
      })),
    };
  }

  if (blocked) {
    const err = new Error(`retention: refusing to prune — ${reason}`);
    err.code = 'RETENTION_BLOCKED';
    err.blocked = true;
    err.reason = reason;
    err.removed = expiredRows.length;
    err.kept = base.kept;
    err.cutoffISO = base.cutoffISO;
    err.dryRun = false;
    err.batches = batchHits;
    throw err;
  }

  if (expiredRows.length === 0) {
    return { ...base, removed: 0, kept: rows.length, tombstone: null, removedRoot: null };
  }

  // Audit before destroy: the tombstone is written first, so a crash mid-prune still
  // leaves a record of what was meant to go.
  store.ensure();
  const removedIndexes = new Set(expiredRows.map(({ i }) => i));
  const removedLines = expiredRows.map(({ i }) => lines[i]).filter(Boolean);
  const removedEntries = expiredRows.map(({ row }) => row.entry);
  const removedRoot = merkleRoot(removedEntries.map((e) => e.hash || store.entryDigest(e, e.prevHash)));
  const boundaryIdx = rows.findIndex((row, i) => !removedIndexes.has(i) && row.ok);
  const boundaryRow = boundaryIdx === -1 ? null : rows[boundaryIdx];
  const firstRemoved = removedEntries[0];
  const lastRemoved = removedEntries[removedEntries.length - 1];

  const tombstone = {
    at: new Date().toISOString(),
    policyDays: report.policyDays,
    cutoffISO: report.cutoffISO,
    removedCount: expiredRows.length,
    keptCount: base.kept,
    removedSeqs: { from: firstRemoved.seq, to: lastRemoved.seq },
    removedRoot,
    removedLinesDigest: sha256(removedLines.join('\n')),
    removedEntries: removedEntries.map((e) => ({ seq: e.seq, ts: e.ts, chash: e.chash || null })),
    boundaryPrevHash: boundaryRow ? boundaryRow.entry.prevHash : null,
    firstKeptSeq: boundaryRow ? boundaryRow.entry.seq : null,
    note: 'content destroyed under CERT-In retention; roots and content digests kept so the deletion stays provable',
  };
  fs.appendFileSync(TOMBSTONE, JSON.stringify(tombstone) + '\n');

  const keptLines = lines.filter((_, i) => !removedIndexes.has(i));
  fs.writeFileSync(store.LOGS, keptLines.length ? keptLines.join('\n') + '\n' : '');

  return {
    ...base,
    removed: expiredRows.length,
    kept: keptLines.length,
    tombstone: TOMBSTONE,
    removedRoot,
    firstKeptSeq: tombstone.firstKeptSeq,
  };
}

module.exports = { retentionReport, pruneExpired, retentionStatus, formatAge, DEFAULT_DAYS, DAY_MS, TOMBSTONE };
