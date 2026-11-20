'use strict';
/**
 * retention.js (CLI) — "show me the 180-day policy working".
 *
 *   node scripts/retention.js                     report against the live store
 *   node scripts/retention.js --json              same report, machine readable
 *   node scripts/retention.js --prune --dry-run   what retention would destroy (the default)
 *   node scripts/retention.js --prune             actually destroy expired, UNANCHORED entries
 *   node scripts/retention.js --days 90           any policy length
 *
 * Exit codes:
 *   0  compliant — nothing on disk has aged past the policy
 *   3  the oldest entry is older than the policy (retention is overdue)
 *   4  prune refused: the expired entries are inside a published batch (evidence, not garbage)
 */
require('../lib/env');
const { retentionReport, pruneExpired, retentionStatus, formatAge, DAY_MS } = require('../lib/retention');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const asJson = has('--json');
const doPrune = has('--prune');
const dryRun = has('--dry-run') || !doPrune; // --prune alone is the only way to delete
const days = Number(valueOf('--days', 180));
const now = new Date();

if (!Number.isFinite(days) || days <= 0) {
  console.error(`  invalid --days ${valueOf('--days', '')}`);
  process.exit(1);
}

function perDayWindow(report, n = 7) {
  const counts = new Map(report.perDay.map((d) => [d.date, d.count]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ date, count: counts.get(date) || 0 });
  }
  return out;
}

function printReport(r) {
  const age = (iso) => (iso ? formatAge(now.getTime() - Date.parse(iso)) + ' ago' : '—');
  const width = Math.max(...r.perDay.map((d) => d.count), 1);
  const bar = (c) => (c ? '#'.repeat(Math.max(1, Math.round((c / width) * 34))) : '');

  console.log('');
  console.log('  Trackfoots — CERT-In retention');
  console.log(`  ${'-'.repeat(58)}`);
  console.log(`  policy         ${r.policyDays} days`);
  console.log(`  cutoff         ${r.cutoffISO}`);
  console.log(`  entries        ${r.totalEntries}   (in policy ${r.inPolicy}, expired ${r.expired})`);
  console.log(`  oldest         ${r.oldestISO || '—'}   ${age(r.oldestISO)}`);
  console.log(`  newest         ${r.newestISO || '—'}   ${age(r.newestISO)}`);
  if (r.undated) console.log(`  undated        ${r.undated}   (no readable ts — counted as retained, never destroyed)`);
  console.log(`  status         ${retentionStatus({ days, now })}`);
  console.log('');
  console.log('  entries per day (last 7)');
  for (const d of perDayWindow(r, 7)) {
    console.log(`    ${d.date}  ${String(d.count).padStart(5)}  ${bar(d.count)}`);
  }
  console.log('');
}

function printPrune(p) {
  console.log('');
  console.log(`  ${p.dryRun ? 'DRY RUN' : 'PRUNE'} — ${p.removed} expired entr${p.removed === 1 ? 'y' : 'ies'}, ${p.kept} kept`);
  console.log(`  ${'-'.repeat(58)}`);
  console.log(`  cutoff         ${p.cutoffISO}`);
  if (p.candidates && p.candidates.length) {
    const shown = p.candidates.slice(0, 5);
    for (const c of shown) {
      console.log(`    #${String(c.seq).padStart(4)}  ${c.ts}  ${c.actor.padEnd(8)} ${c.action}${c.anchored ? '   [ANCHORED]' : ''}`);
    }
    if (p.candidates.length > shown.length) console.log(`    … ${p.candidates.length - shown.length} more`);
  }
  if (p.blocked) {
    console.log('');
    console.log(`  BLOCKED — ${p.reason}`);
    for (const b of p.batches) {
      console.log(`    batch ${String(b.batch).padStart(3)}  seq ${b.seqRange}  ${b.entries} expired  tx ${String(b.txHash).slice(0, 18)}…`);
    }
  } else if (p.dryRun) {
    console.log('');
    console.log('  nothing was touched — dry run. Re-run with --prune to delete.');
  } else {
    console.log('');
    console.log(`  removed    ${p.removed}`);
    console.log(`  removedRoot ${String(p.removedRoot).slice(0, 32)}…`);
    console.log(`  tombstone  ${p.tombstone}`);
  }
  console.log('');
}

const mode = doPrune ? 'prune' : 'report';

/** Run the prune, turning a refusal into the same shape the dry run reports. */
function attemptPrune() {
  try {
    return { ok: true, p: pruneExpired({ days, dryRun, now }) };
  } catch (err) {
    if (err.blocked) return { ok: false, p: err };
    throw err;
  }
}

if (mode === 'report') {
  const r = retentionReport({ days, now });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.compliant ? 0 : 3);
  }
  printReport(r);
  if (!r.compliant) {
    console.log(`  OVERDUE — the oldest entry is ${r.oldestAgeDays}d old, past the ${r.policyDays}-day policy.`);
    console.log('  Inspect what retention would destroy:  node scripts/retention.js --prune --dry-run\n');
    process.exit(3);
  }
  console.log(`  COMPLIANT — every entry on disk is inside the ${r.policyDays}-day window.\n`);
  process.exit(0);
}

const { ok, p } = attemptPrune();
const after = retentionReport({ days, now });

// A refused REAL prune is an error (4). A dry run is a report: nothing was destroyed,
// so it takes the normal compliance exit code (0 / 3).
const code = ok ? (after.compliant ? 0 : 3) : 4;

if (asJson) console.log(JSON.stringify(p, null, 2));
else printPrune(p);

process.exit(code);
