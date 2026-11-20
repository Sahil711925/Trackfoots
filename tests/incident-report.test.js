'use strict';
/**
 * incident-report.test.js — the artifact must not say more than the evidence supports.
 */
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');
const { build, summarise } = require(path.join(REPO, 'lib', 'incident-report.js'));

const cleanReport = {
  verdict: 'VERIFIED',
  entriesExpected: 1200,
  entriesOnDisk: 1200,
  missingEntries: [],
  alteredEntries: [],
  chainOk: true,
  badBatches: [],
  batchesPublished: 12,
  receipts: { total: 1200, valid: 1200, invalid: 0 },
};

const tamperedReport = {
  verdict: 'TAMPERED',
  entriesExpected: 1200,
  entriesOnDisk: 1166,
  missingEntries: Array.from({ length: 34 }, (_, i) => ({ seq: 201 + i })),
  alteredEntries: Array.from({ length: 7 }, (_, i) => ({ seq: 240 + i })),
  chainOk: true,
  badBatches: [{ batch: 3, seqRange: '201-300', publishedRoot: 'a'.repeat(64), recomputedRoot: 'b'.repeat(64) }],
  batchesPublished: 12,
  receipts: { total: 1200, valid: 1193, invalid: 0 },
};

const ledger = [{ batch: 3, seqRange: '201-300', root: 'a'.repeat(64), chain: 'LOCAL-SIMULATED', tx: null }];
const chain = { address: '0x93C6b8B06Ab9FFeAa46Cdcb39ea9A0E43a2949b3', network: 'local' };

test('a clean log produces "no integrity failure", not a fabricated incident', () => {
  const { html, summary } = build(cleanReport, chain, ledger, 'Trackfoots');
  assert.equal(summary.verdict, 'VERIFIED');
  assert.match(html, /No integrity failure detected/);
  assert.doesNotMatch(html, /INTEGRITY FAILURE/);
});

test('a tampered log reports the exact counts', () => {
  const { html, summary } = build(tamperedReport, chain, ledger, 'Trackfoots');
  assert.equal(summary.entriesMissing, 34);
  assert.equal(summary.entriesRewritten, 7);
  assert.equal(summary.affectedBatches.length, 1);
  assert.match(html, /34 entries are missing and 7 were rewritten/);
  assert.match(html, /201-300/);
});

test('the report states what it cannot prove', () => {
  const { html } = build(tamperedReport, chain, ledger, 'Trackfoots');
  assert.match(html, /Cannot prove<\/td><td>The <strong>content<\/strong> of deleted entries/);
  assert.match(html, /Who performed the deletion/);
});

test('the contract address appears so a recipient can verify independently', () => {
  const { html } = build(tamperedReport, chain, ledger, 'Trackfoots');
  assert.match(html, /0x93C6b8B06Ab9FFeAa46Cdcb39ea9A0E43a2949b3/);
});

test('incident ids are unique per generation', () => {
  const a = summarise(tamperedReport, chain, ledger).incidentId;
  const b = summarise(tamperedReport, chain, ledger).incidentId;
  assert.match(a, /^TF-\d{8}-\d{4}-\d{3}$/);
  assert.ok(a.length > 12);
  assert.ok(b.length > 12);
});

test('html escapes hostile content in an actor field', () => {
  const nasty = { ...tamperedReport, entriesMissing: [{ seq: 1, actor: '<script>alert(1)</script>' }] };
  const { html } = build(nasty, chain, ledger, 'Org <img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;img src=x/);
});
