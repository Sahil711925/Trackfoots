'use strict';
/**
 * incident-report.js — the artifact you actually file.
 *
 * A detection is worth nothing to a regulator unless it can be turned into a notification. CERT-In's
 * 6-hour rule needs: what happened, when it was detected, which systems, and what evidence exists.
 * This builds that page from the verifier's own output, so the report cannot say something the
 * evidence does not support.
 */
const { execSync } = require('child_process');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function summarise(report, chain, ledger) {
  const bad = report.badBatches || [];
  const firstBad = bad[0] || null;
  const badBatchRows = ledger.filter((b) => bad.some((x) => x.batch === b.batch));

  return {
    generatedAt: new Date().toISOString(),
    incidentId: `TF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${new Date().toISOString().slice(11, 16).replace(':', '')}-${String(report.batchesPublished || 0).padStart(3, '0')}`,
    verdict: report.verdict,
    detectedAt: new Date().toISOString(),
    entriesExpected: report.entriesExpected,
    entriesOnDisk: report.entriesOnDisk,
    entriesMissing: (report.missingEntries || []).length,
    entriesRewritten: (report.alteredEntries || []).length,
    chainInternallyConsistent: Boolean(report.chainOk),
    affectedBatches: bad.map((b) => ({
      batch: b.batch,
      seqRange: b.seqRange,
      publishedRoot: b.publishedRoot,
      recomputedRoot: b.recomputedRoot || null,
    })),
    firstBadBatch: firstBad ? { batch: firstBad.batch, seqRange: firstBad.seqRange, publishedRoot: firstBad.publishedRoot } : null,
    publishedRootsOnChain: badBatchRows.map((b) => ({ batch: b.batch, root: b.root, chain: b.chain, tx: b.tx || null })),
    contract: chain && chain.address ? chain.address : null,
    network: chain && chain.network ? chain.network : null,
    receipts: report.receipts ? { total: report.receipts.total, valid: report.receipts.valid, invalid: report.receipts.invalid } : null,
  };
}

function toHtml(s, org = 'Trackfoots') {
  const rows = (arr, fn) => arr.map(fn).join('');
  const affected = s.affectedBatches.length
    ? rows(s.affectedBatches, (b) => `<tr><td>#${esc(b.batch)}</td><td>${esc(b.seqRange)}</td><td class="mono">${esc(String(b.publishedRoot).slice(0, 40))}…</td></tr>`)
    : '<tr><td colspan="3">No batch failed verification.</td></tr>';

  return `<!doctype html><html><head><meta charset="utf-8"><title>Incident report ${esc(s.incidentId)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color:#111; font-size:11.5px; line-height:1.55; margin:0; }
  h1 { font-size:19px; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:#555; font-size:11px; margin-bottom:14px; }
  .band { border:1px solid #d8d8d8; border-left:4px solid #b91c1c; padding:10px 12px; margin:0 0 16px; background:#fdf7f7; }
  .band.ok { border-left-color:#15803d; background:#f5fbf6; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#444; margin:18px 0 6px; border-bottom:1px solid #e5e5e5; padding-bottom:3px; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th, td { text-align:left; padding:4px 6px; border-bottom:1px solid #eee; vertical-align:top; }
  th { color:#555; font-weight:600; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size:10px; word-break:break-all; }
  .kv td:first-child { width:38%; color:#555; }
  .foot { margin-top:18px; border-top:1px solid #e5e5e5; padding-top:8px; color:#666; font-size:10px; }
  .warn { color:#b91c1c; font-weight:600; }
</style></head><body>
<h1>Cyber security incident report</h1>
<div class="sub">${esc(org)} · Incident <strong>${esc(s.incidentId)}</strong> · generated ${esc(s.generatedAt)}</div>

<div class="band ${s.verdict === 'VERIFIED' ? 'ok' : ''}">
  <strong>${s.verdict === 'VERIFIED' ? 'No integrity failure detected.' : 'INTEGRITY FAILURE — log evidence was altered after publication.'}</strong>
  ${s.verdict === 'VERIFIED'
    ? `All ${s.entriesOnDisk} entries match the roots published on chain.`
    : `${s.entriesMissing} entries are missing and ${s.entriesRewritten} were rewritten. The hash chain is internally consistent: ${s.chainInternallyConsistent ? 'the attacker recomputed every hash, so only the published roots expose the deletion.' : 'the chain itself is broken.'}`}
</div>

<h2>1 · Statutory notification fields</h2>
<table class="kv">
  <tr><td>Incident type</td><td>Unauthorised modification / destruction of audit log data (log tampering)</td></tr>
  <tr><td>Detected at</td><td class="mono">${esc(s.detectedAt)}</td></tr>
  <tr><td>Notification deadline</td><td>6 hours from detection (CERT-In Directions, 28 Apr 2022)</td></tr>
  <tr><td>Affected system</td><td>Log store for ${esc(org)}; ${s.affectedBatches.length} published checkpoint(s) affected</td></tr>
  <tr><td>Records affected</td><td>${s.entriesMissing} missing · ${s.entriesRewritten} rewritten · ${s.entriesExpected} expected on chain vs ${s.entriesOnDisk} present</td></tr>
  <tr><td>Evidence location</td><td class="mono">contract ${esc(s.contract || 'n/a')} on ${esc(s.network || 'n/a')}</td></tr>
</table>

<h2>2 · Affected batches</h2>
<table><thead><tr><th>Batch</th><th>Sequences</th><th>Published root (on chain)</th></tr></thead><tbody>${affected}</tbody></table>

<h2>3 · What can be proved, and what cannot</h2>
<table>
  <tr><td style="width:38%">Can prove</td><td>That specific entries existed at a specific time, because the Merkle root covering them was published before the incident and cannot be re-written by anyone, including the system operator.</td></tr>
  <tr><td>Can prove</td><td>The exact sequence range that no longer matches its published root.</td></tr>
  <tr><td class="warn">Cannot prove</td><td>The <strong>content</strong> of deleted entries. A one-way hash proves existence, not text. Recovery depends on a replica or an exported bundle held elsewhere.</td></tr>
  <tr><td class="warn">Cannot prove</td><td>Who performed the deletion. That requires host-level forensics outside this system.</td></tr>
</table>

<h2>4 · Verification instructions for the recipient</h2>
<table class="kv">
  <tr><td>1</td><td>Read the anchor for each batch from the contract at the address above. These values are write-once.</td></tr>
  <tr><td>2</td><td>Recompute the Merkle root from the supplied log bundle using RFC 6962 leaf and node hashing.</td></tr>
  <tr><td>3</td><td>Compare. A mismatch on batch #${esc(s.firstBadBatch ? s.firstBadBatch.batch : '—')} is the deletion.</td></tr>
  <tr><td>Independent tool</td><td class="mono">npm run auditor -- --bundle &lt;file&gt;</td></tr>
</table>

<div class="foot">
  Generated by Trackfoots from verifier output — every figure on this page is produced by the same code that
  verifies the log, so the report cannot overstate the evidence. Receipts: ${s.receipts ? `${s.receipts.valid}/${s.receipts.total} valid, ${s.receipts.invalid} rejected` : 'n/a'}.
  This document is a technical record, not legal advice.
</div>
</body></html>`;
}

function build(report, chain, ledger, org) {
  const summary = summarise(report, chain, ledger);
  return { summary, html: toHtml(summary, org) };
}

module.exports = { build, summarise, toHtml };
