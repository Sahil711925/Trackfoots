'use strict';
/**
 * receipt-tree.test.js — the receipt SET commitment.
 *
 * A signed receipt proves one line was witnessed. It does not prove that the receipts handed
 * to an auditor are all the receipts that exist: drop one from the store and every survivor
 * still verifies. These tests hold the Merkle commitment over the receipt set to that gap:
 * the root is deterministic, single receipts have audit paths into it, dropping one receipt
 * breaks the root check, and a forged signature is rejected.
 *
 * Runs against an isolated temp data dir; the real data/ and the demo on :5173 are untouched.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const SCRATCH = process.env.TMPDIR || os.tmpdir();
const DATA = path.join(SCRATCH, `witness-receipts-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.WITNESS_TEST = '1';
process.env.BATCH_SIZE = '100';
process.env.RECEIPT_SECRET = 'test-secret-for-receipt-suite-0123456789';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const receipts = require(path.join(REPO, 'lib', 'receipts.js'));
const tree = require(path.join(REPO, 'lib', 'receipt-tree.js'));
const { verifyReceipts, verifyPayload } = require(path.join(REPO, 'lib', 'auditor.js'));
const { bundlePayload } = require(path.join(REPO, 'lib', 'bundle.js'));
const { sha256, merkleRoot, EMPTY_ROOT } = require(path.join(REPO, 'lib', 'merkle.js'));

const N = 25;
const CLI = path.join(REPO, 'scripts', 'verify-receipts.js');

let all;
let root;
let payload;
const tmpFiles = [];

const mk = (i) => ({
  ts: new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(),
  actor: `analyst-${i % 3}`,
  action: i % 2 ? 'login success' : 'DELETE /api/records/77',
  meta: { ip: `10.1.0.${i % 200}`, ua: 'receipt-suite' },
});

before(() => {
  store.ensure();
  store.appendMany(Array.from({ length: N }, (_, i) => mk(i)));

  const entries = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
  const batchRoot = merkleRoot(entries.map((e) => e.hash));
  store.appendLedger({
    batch: 1,
    seq: 1_800_000_000_001,
    fromSeq: 1,
    toSeq: N,
    count: N,
    root: batchRoot,
    checkpointRoot: batchRoot,
    ts: new Date().toISOString(),
    txHash: `0x${sha256(`tx|1|${batchRoot}`)}`,
    chain: 'LOCAL-SIMULATED',
    explorer: null,
  });

  all = store.readReceipts();
  root = tree.buildReceiptRoot(all).root;
  payload = bundlePayload(5);
});

after(() => {
  for (const f of tmpFiles) fs.rmSync(f, { force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

function writeTmp(name, obj) {
  const f = path.join(DATA, name);
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
  tmpFiles.push(f);
  return f;
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, WITNESS_DATA: DATA },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

/* ------------------------------------------------------------------ leaves */

test('the receipt leaf commits seq|chash|ts, the same fields the signature covers', () => {
  const r = all[0];
  assert.equal(receipts.canonical(r), `${r.seq}|${r.chash}|${r.ts}`);
  assert.equal(tree.leafContent(r), `receipt/v1|${r.seq}|${r.chash}|${r.ts}`);
  assert.equal(tree.canonical(r), receipts.canonical(r), 'tree and signer must agree byte for byte');
  assert.throws(() => tree.leafContent({ seq: 1 }), TypeError);
});

/* ------------------------------------------------------------------- roots */

test('the receipt root is deterministic and independent of file order', () => {
  assert.equal(all.length, N, 'one receipt per written line');
  assert.match(root, /^[0-9a-f]{64}$/);
  assert.equal(tree.buildReceiptRoot(all).count, N);

  const shuffled = [...all].reverse();
  shuffled.push(shuffled[3]); // a byte-identical duplicate adds no information
  const again = tree.buildReceiptRoot(shuffled);
  assert.equal(again.root, root, 'a different arrival order must produce the same root');
  assert.equal(again.count, N, 'duplicates collapse to one leaf');
});

test('an empty receipt set hashes to the RFC 6962 empty root, not to a leaf', () => {
  const empty = tree.buildReceiptRoot([]);
  assert.equal(empty.root, EMPTY_ROOT);
  assert.equal(empty.count, 0);
  assert.match(EMPTY_ROOT, /^[0-9a-f]{64}$/);
  assert.notEqual(EMPTY_ROOT, require(path.join(REPO, 'lib', 'merkle.js')).leafDigest(''));
});

/* --------------------------------------------------------------- inclusion */

test('every receipt has an inclusion proof that rebuilds the committed root', () => {
  for (let i = 0; i < all.length; i++) {
    const p = tree.buildReceiptProof(all, all[i]);
    assert.ok(p, `receipt ${all[i].seq} must be found in the set`);
    assert.equal(p.root, root);
    assert.equal(p.size, N);
    assert.equal(tree.verifyReceiptInclusion(all[i], p.proof, p.index, p.size), root, `receipt ${all[i].seq}`);
  }
});

test('an inclusion proof does not verify for a receipt that was altered', () => {
  const p = tree.buildReceiptProof(all, all[7]);
  const tampered = { ...all[7], ts: '2026-03-01T23:59:59.000Z' };
  assert.notEqual(tree.verifyReceiptInclusion(tampered, p.proof, p.index, p.size), root);
  assert.throws(() => tree.verifyReceiptInclusion(all[7], [], p.index, p.size), /proof too short/);
  assert.throws(() => tree.verifyReceiptInclusion(all[7], p.proof, 'x', p.size), /index and size are required/);
});

/* ------------------------------------------------------------ completeness */

test('dropping one receipt breaks the root and is reported as incomplete', () => {
  const dropped = all.filter((_, i) => i !== 4);
  assert.notEqual(tree.buildReceiptRoot(dropped).root, root, 'a missing receipt must change the root');

  const v = tree.verifyReceiptSet(dropped, { root, count: N });
  assert.equal(v.ok, false);
  assert.equal(v.incomplete, true);
  assert.equal(v.present, N - 1);
  assert.equal(v.committed, N);
  assert.match(v.problem, new RegExp(`receipt set is incomplete: ${N - 1} present, ${N} committed`));
});

test('a receipt swapped for a different one is caught even when the count matches', () => {
  const swapped = [...all];
  swapped[2] = { ...swapped[2], chash: sha256('some other content') };
  const v = tree.verifyReceiptSet(swapped, { root, count: N });
  assert.equal(v.ok, false);
  assert.equal(v.present, N, 'the count is unchanged, so only the root can catch this');
  assert.match(v.problem, /does not reproduce the committed root/);
});

test('the full set reproduces the root and reports the counts', () => {
  const v = tree.verifyReceiptSet(all, { root, count: N });
  assert.equal(v.ok, true);
  assert.equal(v.present, N);
  assert.equal(v.computedRoot, root);
  assert.equal(v.problem, null);
});

/* ---------------------------------------------------------------- forgery */

test('a forged receipt signature is rejected by the auditor', () => {
  const forged = receipts.makeForged(all[9]);
  assert.equal(receipts.verify(forged), 'invalid');

  const withForgery = all.map((r, i) => (i === 9 ? forged : r));
  const v = verifyReceipts({
    receipts: withForgery,
    receiptRoot: tree.buildReceiptRoot(withForgery).root,
    receiptCount: N,
  });

  const sigCheck = v.checks.find((c) => c.name === 'every receipt signature is valid');
  assert.ok(sigCheck, 'the bundle must be checked for signatures');
  assert.equal(sigCheck.ok, false);
  assert.match(sigCheck.detail, /1 invalid/);
  assert.equal(v.ok, false, 'a set that hashes correctly is still rejected when a signature is forged');
});

test('an authentic set passes both receipt checks', () => {
  const v = verifyReceipts({ receipts: all, receiptRoot: root, receiptCount: N });
  assert.equal(v.ok, true, v.checks.map((c) => `${c.name}: ${c.ok}`).join(' | '));
  assert.equal(v.summary.signatures.valid, N);
  assert.equal(v.summary.persistentKey, true, 'the suite supplies RECEIPT_SECRET, so signatures are judgeable');
});

/* ------------------------------------------------------------------ bundle */

test('the exported bundle carries the receipt set and its root', () => {
  assert.equal(payload.bundle, 'trackfoots-evidence/v1');
  assert.equal(payload.receiptCount, N);
  assert.equal(payload.receiptRoot, root);
  assert.equal(payload.receipts.length, N);
  assert.match(payload.receiptLeaf, /receipt\/v1/);
  assert.ok(payload.receiptProof, "the bundle carries this entry's own receipt proof");
  const e5 = store.readLogs().find((r) => r.ok && r.entry.seq === 5).entry;
  assert.equal(payload.receipt.chash, e5.chash);
  assert.equal(
    tree.verifyReceiptInclusion(payload.receipt, payload.receiptProof, payload.receiptIndex, payload.receiptSize),
    root
  );
});

test('a bundle whose receipt set was truncated fails the whole payload check', async () => {
  const clean = await verifyPayload(payload, {});
  assert.equal(clean.verified, true, clean.checks.map((c) => `${c.name}: ${c.ok}`).join(' | '));

  const truncated = { ...payload, receipts: payload.receipts.slice(0, -3) };
  const bad = await verifyPayload(truncated, {});
  assert.equal(bad.verified, false);

  const setCheck = bad.checks.find((c) => c.name === 'receipt set reproduces the committed receipt root');
  assert.equal(setCheck.ok, false);
  assert.match(setCheck.detail, new RegExp(`receipt set is incomplete: ${N - 3} present, ${N} committed`));
});

test('a bundle with no receipt commitment is not silently treated as complete', async () => {
  const { receipts: _r, receiptRoot: _rr, receiptCount: _rc, ...legacy } = payload;
  const r = await verifyPayload(legacy, {});
  assert.equal(r.verified, true, 'legacy bundles still verify on the entry proof alone');
  assert.equal(r.receipts, null, 'but no receipt claim is made for them');

  const half = await verifyPayload({ ...payload, receipts: undefined }, {});
  assert.equal(half.verified, false, 'a committed root with no list must fail');
});

/* --------------------------------------------------------------------- CLI */

test('scripts/verify-receipts.js exits 0 on a complete bundle', () => {
  const file = writeTmp('bundle-good.json', payload);
  const r = runCli(['--bundle', file]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${N} present`));
  assert.match(r.stdout, new RegExp(`${N} committed`));
  assert.match(r.stdout, /receipt set is complete and authentic/);
  assert.match(r.stdout, new RegExp(root));
});

test('scripts/verify-receipts.js exits non-zero and names the gap on a truncated bundle', () => {
  const file = writeTmp('bundle-short.json', { ...payload, receipts: payload.receipts.slice(1) });
  const r = runCli(['--bundle', file]);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`receipt set is incomplete: ${N - 1} present, ${N} committed`));
  assert.match(r.stdout, /does NOT verify/);
});

test('scripts/verify-receipts.js pins an out-of-band root with --expect-root', () => {
  const file = writeTmp('bundle-pin.json', payload);
  const good = runCli(['--bundle', file, '--expect-root', root, '--expect-count', String(N)]);
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /root pinned out-of-band/);

  const pinnedElsewhere = runCli(['--bundle', file, '--expect-root', sha256('another day')]);
  assert.equal(pinnedElsewhere.code, 2);
  assert.match(pinnedElsewhere.stdout, /does not reproduce the committed root/);
});
