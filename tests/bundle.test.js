'use strict';
/**
 * bundle.test.js — lib/bundle.js buildBundle(seq).
 *
 * The evidence bundle is the artifact handed to a third party, so the test holds it to
 * the promises in its own header: it exists on disk, it is a real page (> 2 KB), it
 * names the entry hash, the published root and the tx hash verbatim, it refuses an
 * unknown seq, and it contains no JavaScript and no external asset to fetch.
 *
 * Runs against an isolated temp data dir; the real data/ is never touched. The exporter
 * writes into repo/exports (it has no data-dir override), so the generated file is
 * removed again in after().
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-bundle-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { sha256, merkleRoot } = require(path.join(REPO, 'lib', 'merkle.js'));
const { buildBundle, EXPORTS_DIR } = require(path.join(REPO, 'lib', 'bundle.js'));
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';

const SEQ = 42; // not one of the bundles already sitting in exports/
const OUT = path.join(REPO, 'exports', `bundle-${SEQ}.html`);

let batch;
let entry;
let out;

const mk = (i) => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  actor: `user-${i % 3}`,
  action: i % 2 ? 'login success' : 'DELETE /api/orders/1182',
  meta: { ip: `10.0.0.${i % 250}`, ua: 'bundle-test', session: 1000 + i },
});

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

before(async () => {
  store.ensure();
  store.appendMany(Array.from({ length: 100 }, (_, i) => mk(i)));
  batch = publish(store.readLogs().filter((r) => r.ok).map((r) => r.entry), 1);
  entry = store.readLogs().filter((r) => r.ok).map((r) => r.entry).find((e) => e.seq === SEQ);
  assert.ok(entry, 'entry 42 must exist');
  assert.equal(fs.existsSync(OUT), false, 'test must not overwrite a pre-existing bundle');
  out = await buildBundle(SEQ);
});

after(() => {
  fs.rmSync(OUT, { force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('buildBundle() writes a self-contained HTML file larger than 2 KB', async () => {
  assert.equal(out.path, OUT);
  assert.equal(EXPORTS_DIR, path.dirname(OUT));
  assert.ok(fs.existsSync(OUT), 'bundle file must exist on disk');

  const size = fs.statSync(OUT).size;
  assert.ok(size > 2048, `bundle must be > 2 KB, got ${size} bytes`);
  assert.equal(fs.readFileSync(OUT, 'utf8'), out.html, 'returned html must be what was written');
  assert.equal(out.included, true, 'a clean entry must be included');
});

test('the bundle names the entry hash, the published root and the tx hash verbatim', () => {
  const html = out.html;
  assert.ok(html.includes(entry.hash), 'entry hash must appear in full');
  assert.ok(html.includes(entry.prevHash), 'previous hash must appear');
  assert.ok(html.includes(batch.root), 'published Merkle root must appear in full');
  assert.ok(html.includes(batch.txHash), 'tx hash must appear');
  assert.ok(html.includes(`#${SEQ}`), 'the entry number must be printed');
  assert.match(html, /TRACKFOOTS/);
  assert.match(html, /Integrity established/i);
  assert.match(html, /<!DOCTYPE html>/i);
});

test('the bundle contains no <script> tag and no external src/link', () => {
  const html = out.html;
  assert.equal(/<script\b/i.test(html), false, 'no script tag allowed: a printed exhibit must not execute anything');
  assert.equal(/<\/script>/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'no inline event handlers');
  assert.equal(/\ssrc\s*=/i.test(html), false, 'no src= asset reference');
  assert.equal(/<link\b/i.test(html), false, 'no external stylesheet');
  assert.equal(/<iframe\b/i.test(html), false);
  assert.equal(/https?:\/\//i.test(html), false, 'no absolute URL to fetch');
  assert.equal(/url\(\s*['"]?https?:/i.test(html), false);
});

test('buildBundle() fails cleanly for a seq that does not exist', async () => {
  const err = await buildBundle(9999).then(
    () => null,
    (e) => e
  );
  assert.ok(err, 'an unknown seq must reject');
  assert.equal(err.code, 'ENOENTRY');
  assert.match(err.message, /not found in the log/i);
  assert.equal(fs.existsSync(path.join(REPO, 'exports', 'bundle-9999.html')), false);
});

test('buildBundle() fails cleanly for an entry whose batch was never published', async () => {
  store.appendMany([mk(500)]); // seq 101, no ledger row covers it
  const err = await buildBundle(101).then(
    () => null,
    (e) => e
  );
  assert.ok(err, 'an un-anchored entry must reject');
  assert.equal(err.code, 'ENOBATCH');
  assert.match(err.message, /not covered by any published batch/i);
});

test('buildBundle() rejects nonsense sequence numbers', async () => {
  for (const bad of [0, -1, 4.5, 'abc']) {
    const err = await buildBundle(bad).then(
      () => null,
      (e) => e
    );
    assert.ok(err, `buildBundle(${JSON.stringify(bad)}) must reject`);
    assert.equal(err.code, 'EBADSEQ');
    assert.match(err.message, /invalid sequence number/i);
  }
});
