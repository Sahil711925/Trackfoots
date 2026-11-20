'use strict';
/**
 * ingest.test.js — the write path a real deployment uses.
 *
 * Up to now every entry arrived from a seeder. These tests cover the API contract:
 * validation, batch limits, and the signed receipt handed back to the emitter.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-ingest-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.RECEIPT_SECRET = 'test-secret-for-ingest-suite-0123456789';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const receipts = require(path.join(REPO, 'lib', 'receipts.js'));
const { ingest, MAX_BATCH } = require(path.join(REPO, 'lib', 'ingest.js'));

before(() => store.ensure());
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('accepts one entry and returns a verifiable receipt', () => {
  const before = store.readLogs().filter((r) => r.ok).length;
  const out = ingest({ actor: 'rahul', action: 'ssh login accepted', meta: { ip: '103.21.44.9' } });

  assert.equal(out.accepted, 1);
  assert.equal(out.receipts.length, 1);
  const r = out.receipts[0];
  assert.equal(r.seq, before + 1, 'sequence continues from the existing log');
  assert.match(r.chash, /^[0-9a-f]{64}$/);
  assert.equal(receipts.verify(r), 'valid', 'the receipt signature must verify with our key');
});

test('the written line round-trips with the same content hash', () => {
  const out = ingest({ actor: 'priya', action: 'sudo /bin/cat /etc/shadow', meta: { tty: 'pts/2' } });
  const seq = out.receipts[0].seq;
  const stored = store.readLogs().map((r) => r.ok && r.entry).find((e) => e && e.seq === seq);

  assert.ok(stored, 'entry must be on disk');
  assert.equal(stored.actor, 'priya');
  assert.equal(stored.action, 'sudo /bin/cat /etc/shadow');
  assert.equal(store.contentDigest(stored), out.receipts[0].chash);
});

test('a batch assigns increasing sequences and one receipt each', () => {
  const out = ingest({
    entries: [
      { actor: 'a', action: 'GET /health 200' },
      { actor: 'b', action: 'GET /api/orders 200' },
      { actor: 'c', action: 'POST /api/login 401' },
    ],
  });
  assert.equal(out.accepted, 3);
  assert.equal(out.receipts.length, 3);
  const seqs = out.receipts.map((r) => r.seq);
  assert.deepEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2]);
  for (const r of out.receipts) assert.equal(receipts.verify(r), 'valid');
});

test('rejects an entry with no action, and reports why', () => {
  const out = ingest({ entries: [{ actor: 'x' }, { actor: 'y', action: 'ok' }] });
  assert.equal(out.accepted, 1, 'only the valid entry is stored');
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0].reason, /action is required/);
});

test('rejects invalid timestamps and non-object meta', () => {
  const out = ingest({
    entries: [
      { action: 'a', ts: 'not-a-date' },
      { action: 'b', meta: 'string-instead-of-object' },
      { action: 'c', meta: { ok: true } },
    ],
  });
  assert.equal(out.accepted, 1);
  assert.equal(out.rejected.length, 2);
});

test('enforces the batch limit', () => {
  const many = Array.from({ length: MAX_BATCH + 1 }, () => ({ action: 'flood' }));
  assert.throws(() => ingest({ entries: many }), /too many entries/);
});

test('rejects an oversized meta payload', () => {
  const big = { blob: 'x'.repeat(5000) };
  const out = ingest({ entries: [{ action: 'big', meta: big }] });
  assert.equal(out.accepted, 0);
  assert.match(out.rejected[0].reason, /too large/);
});
