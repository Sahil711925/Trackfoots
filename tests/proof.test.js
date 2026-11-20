'use strict';
/**
 * proof.test.js — lib/proof.js buildProof(seq) / formatProofText.
 *
 * Covers the single-entry inclusion proof: it must be true for an untouched entry,
 * collapse to false when the entry's text is edited even though the stored hash is
 * left alone, return null when there is nothing to prove (no such entry, or the
 * entry's batch was never published), and rebuild exactly the published root.
 *
 * Runs against an isolated temp data dir; the real data/ is never touched.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-proof-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
// store first, so it captures the temp data dir before anything pulls in lib/env.
const store = require(path.join(REPO, 'lib', 'store.js'));
const { sha256, merkleRoot, verifyProof } = require(path.join(REPO, 'lib', 'merkle.js'));
const { buildProof, formatProofText } = require(path.join(REPO, 'lib', 'proof.js'));

// proof.js requires lib/env, which forces a few keys from .env. Put ours back.
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';

const HASH_RE = /^[0-9a-f]{64}$/;
let batch; // the single published batch covering seq 1-100

const mk = (i) => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  actor: `user-${i % 3}`,
  action: i % 2 ? 'login success' : 'GET /api/orders',
  meta: { ip: `10.0.0.${i % 250}`, ua: 'proof-test', session: 1000 + i },
});

/** Publish one batch the same way scripts/anchor.js does in offline mode. */
function publish(entries, batchNo) {
  const root = merkleRoot(entries.map((e) => e.hash));
  const ts = new Date().toISOString();
  const txHash = `0x${sha256(`tx|${batchNo}|${root}|${ts}`)}`;
  const row = {
    batch: batchNo,
    seq: 1_700_000_000_000 + batchNo,
    fromSeq: entries[0].seq,
    toSeq: entries[entries.length - 1].seq,
    count: entries.length,
    root,
    ts,
    txHash,
    chain: 'LOCAL-SIMULATED',
    explorer: null,
  };
  store.appendLedger(row);
  return row;
}

before(() => {
  store.ensure();
  store.appendMany(Array.from({ length: 100 }, (_, i) => mk(i)));
  batch = publish(store.readLogs().filter((r) => r.ok).map((r) => r.entry), 1);
  // Entries 101-105 exist on disk but are deliberately left un-anchored.
  store.appendMany(Array.from({ length: 5 }, (_, i) => mk(200 + i)));
  assert.equal(store.readLedger().length, 1);
  assert.ok(store.LOGS.includes(DATA), 'log file must live under the test data dir');
});

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

const entryOf = (seq) => store.readLogs().filter((r) => r.ok).map((r) => r.entry).find((e) => e.seq === seq);

test('buildProof() verifies true on clean data', () => {
  const p = buildProof(42);
  assert.ok(p, 'a proof must exist for an anchored entry');
  assert.equal(p.seq, 42);
  assert.equal(p.verified, true);
  assert.equal(p.hashMatches, true);
  assert.equal(p.reason, null);
  assert.equal(p.batch, 1);
  assert.equal(p.batchRange, '1-100');
  assert.equal(p.batchFromSeq, 1);
  assert.equal(p.batchToSeq, 100);
  assert.equal(p.leafIndex, 41, 'seq 42 is leaf 41 of a batch starting at seq 1');
  assert.equal(p.leafCount, 100);
  assert.deepEqual(p.missingSeqs, []);
  assert.equal(p.chain, 'LOCAL-SIMULATED');
  assert.equal(p.format, 'witness-inclusion-proof/1');
});

test('the proof rebuilds the published root from the recomputed entry hash', () => {
  const p = buildProof(42);
  assert.match(p.publishedRoot, HASH_RE);
  assert.match(p.entryHash, HASH_RE);

  // Independent rebuild from the published proof steps, not from the module's own value.
  const rebuilt = verifyProof(p.entryHash, p.proofSteps, p.leafIndex, p.leafCount);
  assert.equal(rebuilt, p.publishedRoot, 'leaf + proof must reproduce the published root');
  assert.equal(p.rebuiltRoot, p.publishedRoot);
  assert.equal(p.recomputedRoot, p.publishedRoot, 'merkle root of the batch on disk matches too');

  // The published root must also match the ledger row, and the leaf must be the entry's own digest.
  assert.equal(p.publishedRoot, batch.root);
  const entry = entryOf(42);
  assert.equal(p.entryHash, store.entryDigest(entry, entry.prevHash));
  assert.equal(p.entryHash, entry.hash);
  assert.equal(p.storedHash, entry.hash);
});

test('proofLength stays within log2(100) bounds for a 100-leaf batch', () => {
  const p = buildProof(42);
  // RFC 6962 trees are left-complete, not level-balanced: the rightmost leaf sits shallower
  // than the leftmost, so the audit path length varies between ceil(log2(100))-3 and 7.
  assert.ok(p.proofLength >= 4 && p.proofLength <= 7, `unexpected proof length ${p.proofLength}`);
  assert.equal(p.proofSteps.length, 7);
  for (const step of p.proofSteps) {
    assert.ok(step.side === 'left' || step.side === 'right', `bad side: ${step.side}`);
    assert.match(step.hash, HASH_RE);
    assert.deepEqual(Object.keys(step).sort(), ['hash', 'side']);
  }
});

test('the proof holds for the first and last leaf of the batch', () => {
  const first = buildProof(1);
  const last = buildProof(100);
  assert.equal(first.verified, true);
  assert.equal(first.leafIndex, 0);
  assert.equal(last.verified, true);
  assert.equal(last.leafIndex, 99);
  assert.equal(verifyProof(first.entryHash, first.proofSteps, first.leafIndex, first.leafCount), batch.root);
  assert.equal(verifyProof(last.entryHash, last.proofSteps, last.leafIndex, last.leafCount), batch.root);
});

test('buildProof() returns null for a seq that was never written', () => {
  assert.equal(buildProof(9999), null);
  assert.equal(buildProof(0), null);
  assert.equal(buildProof(-3), null);
});

test('buildProof() returns null for a non-integer seq instead of throwing', () => {
  assert.equal(buildProof('not-a-number'), null);
  assert.equal(buildProof(NaN), null);
  assert.equal(buildProof(undefined), null);
  assert.equal(buildProof(null), null);
  assert.equal(buildProof(4.5), null);
});

test('buildProof() returns null when the entry exists but its batch was never published', () => {
  assert.ok(entryOf(101), 'entry 101 must be on disk');
  assert.equal(buildProof(101), null);
  assert.equal(buildProof(105), null);
});

test('buildProof() returns false when the entry content is edited but its hash is left alone', () => {
  const file = store.LOGS;
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n').filter(Boolean);

  const idx = lines.findIndex((l) => JSON.parse(l).seq === 42);
  assert.ok(idx >= 0, 'entry 42 must be present in the log file');
  const before = JSON.parse(lines[idx]);
  assert.notEqual(before.action, 'sudo su', 'test edit must actually change the content');

  lines[idx] = JSON.stringify({ ...before, action: 'sudo su' }); // silent edit
  fs.writeFileSync(file, lines.join('\n') + '\n');

  try {
    const p = buildProof(42);
    assert.ok(p, 'the entry still parses, so a proof object is still returned');
    assert.equal(p.hashMatches, false, 'recomputed digest must disagree with the stored hash');
    assert.notEqual(p.entryHash, p.storedHash);
    assert.equal(p.verified, false);
    assert.notEqual(p.rebuiltRoot, p.publishedRoot);
    assert.match(p.reason, /no longer matches/i);
    assert.equal(formatProofText(p).includes('RESULT: VERIFIED'), false);
    assert.match(formatProofText(p), /RESULT: FAILED/);
  } finally {
    fs.writeFileSync(file, original); // restore before later assertions run
  }

  const restored = buildProof(42);
  assert.equal(restored.verified, true, 'restoring the original bytes restores the proof');
});

test('formatProofText() renders the verified proof as plain text', () => {
  const p = buildProof(42);
  const text = formatProofText(p);

  assert.equal(typeof text, 'string');
  assert.match(text, /TRACKFOOTS — MERKLE INCLUSION PROOF/);
  assert.match(text, /entry\s+#42/);
  assert.match(text, /batch\s+1\s+\(seq 1-100, 100 leaves on disk\)/);
  assert.ok(text.includes(p.publishedRoot), 'published root must appear verbatim');
  assert.ok(text.includes(p.entryHash), 'entry hash must appear verbatim');
  assert.ok(text.includes(p.txHash), 'tx hash must appear verbatim');
  assert.match(text, /PROOF \(7 steps, leaf -> root\):/);
  assert.match(text, /verified\s+YES/);
  assert.match(text, /RESULT: VERIFIED/);
  assert.equal(text.includes('MISMATCH'), false);
});

test('formatProofText() explains the empty case instead of throwing', () => {
  const text = formatProofText(null);
  assert.equal(typeof text, 'string');
  assert.match(text, /NO PROOF/);
});
