'use strict';
/**
 * store.test.js — appendMany chaining, digests and receipt mirroring.
 * Runs against an isolated temp data dir; the real data/ is never touched.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-store-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { sha256 } = require(path.join(REPO, 'lib', 'merkle.js'));

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

const mk = (i) => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  actor: `user-${i % 3}`,
  action: i % 2 ? 'login success' : 'GET /api/orders',
  meta: { ip: `10.0.0.${i}`, ua: 'test', session: 1000 + i },
});

const okEntries = () => store.readLogs().filter((r) => r.ok).map((r) => r.entry);

test('BATCH_SIZE defaults to 100', () => {
  assert.equal(store.BATCH_SIZE, 100);
});

test('appendMany writes N entries and reports N', () => {
  const n = 7;
  const written = store.appendMany(Array.from({ length: n }, (_, i) => mk(i)));
  assert.equal(written, n);

  const entries = okEntries();
  assert.equal(entries.length, n);
  assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
});

test('appendMany links every entry to the previous hash, starting at GENESIS', () => {
  const entries = okEntries();
  assert.equal(entries[0].prevHash, 'GENESIS');
  assert.equal(entries[0].hash, store.entryDigest(entries[0], 'GENESIS'));

  for (let i = 1; i < entries.length; i++) {
    assert.equal(entries[i].prevHash, entries[i - 1].hash, `entry ${i + 1} prevHash`);
    assert.equal(entries[i].hash, store.entryDigest(entries[i], entries[i].prevHash), `entry ${i + 1} hash`);
  }
});

test('a second appendMany continues the same chain instead of restarting it', () => {
  const before = okEntries();
  const last = before[before.length - 1];

  assert.equal(store.appendMany([mk(90), mk(91)]), 2);

  const afterRun = okEntries();
  assert.equal(afterRun.length, before.length + 2);
  assert.equal(afterRun[before.length].prevHash, last.hash);
  assert.equal(afterRun[before.length].seq, last.seq + 1);
  assert.equal(afterRun[before.length].hash, store.entryDigest(afterRun[before.length], last.hash));
});

test('every logged entry has a matching auditor receipt written outside the log file', () => {
  const entries = okEntries();
  const receipts = store.readReceipts();

  assert.equal(receipts.length, entries.length);
  for (let i = 0; i < entries.length; i++) {
    assert.equal(receipts[i].seq, entries[i].seq);
    assert.equal(receipts[i].chash, entries[i].chash);
    assert.equal(receipts[i].ts, entries[i].ts);
  }
  assert.ok(store.RECEIPTS.startsWith(DATA), 'receipts must live under the test data dir');
});

test('entryDigest changes when only prevHash changes', () => {
  const e = { seq: 5, ts: '2026-01-01T00:00:00.000Z', actor: 'rahul', action: 'login success', meta: { ip: '1.2.3.4' } };
  const a = store.entryDigest(e, 'GENESIS');
  const b = store.entryDigest(e, sha256('some-other-prev-hash'));

  assert.notEqual(a, b);
  assert.equal(a, store.entryDigest(e, 'GENESIS'), 'digest is deterministic');
});

test('entryDigest changes when any hashed field changes', () => {
  const base = { seq: 5, ts: '2026-01-01T00:00:00.000Z', actor: 'rahul', action: 'login success', meta: { ip: '1.2.3.4' } };
  const digest = store.entryDigest(base, 'GENESIS');
  const variants = [
    { ...base, seq: 6 },
    { ...base, ts: '2026-01-01T00:00:01.000Z' },
    { ...base, actor: 'priya' },
    { ...base, action: 'login failed' },
    { ...base, meta: { ip: '1.2.3.5' } },
  ];
  for (const v of variants) {
    assert.notEqual(store.entryDigest(v, 'GENESIS'), digest, JSON.stringify(v));
  }
  // An absent meta must hash like an empty object, not crash.
  const noMeta = { seq: 5, ts: base.ts, actor: base.actor, action: base.action };
  assert.equal(store.entryDigest(noMeta, 'GENESIS'), store.entryDigest({ ...noMeta, meta: {} }, 'GENESIS'));
});

test('contentDigest identifies the content and ignores seq/prevHash', () => {
  const e = { seq: 5, ts: '2026-01-01T00:00:00.000Z', actor: 'rahul', action: 'login success', meta: { ip: '1.2.3.4' } };
  assert.equal(store.contentDigest(e), store.contentDigest({ ...e, seq: 99, prevHash: 'whatever', hash: 'x' }));
  assert.notEqual(store.contentDigest(e), store.contentDigest({ ...e, actor: 'priya' }));
});
