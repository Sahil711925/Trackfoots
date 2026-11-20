'use strict';
/**
 * verify.empty.test.js — the attack that used to work: delete the whole data directory.
 *
 * With no rows on disk every local comparison succeeds trivially, so an empty store reported
 * VERIFIED. That is the most attractive outcome for an attacker and the least honest for a
 * verifier. An empty store must say so, never "all good".
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-empty-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.WITNESS_TEST = '1';
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.RECEIPT_SECRET = 'test-secret-empty-suite-0123456789';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { verify } = require(path.join(REPO, 'lib', 'verify.js'));

before(() => store.ensure());
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('an empty data directory reports NO DATA, not VERIFIED', () => {
  const r = verify();
  assert.equal(r.entriesOnDisk, 0);
  assert.equal(r.noData, true);
  assert.equal(r.verdict, 'NO DATA', 'a wiped log must never read as verified');
});

test('a populated log clears the noData flag', () => {
  store.appendMany([
    { ts: new Date().toISOString(), actor: 'rahul', action: 'ssh login accepted', meta: {} },
    { ts: new Date().toISOString(), actor: 'priya', action: 'sudo /bin/cat /etc/shadow', meta: {} },
  ]);
  const r = verify();
  assert.equal(r.entriesOnDisk, 2);
  assert.equal(r.noData, false);
  assert.notEqual(r.verdict, 'NO DATA');
});

test('wiping the log while receipts survive is TAMPERED, not merely empty', () => {
  fs.writeFileSync(path.join(DATA, 'logs.jsonl'), '');
  const r = verify();
  assert.equal(r.noData, true);
  assert.equal(r.verdict, 'TAMPERED', 'the off-box receipts still prove lines were written');
  assert.equal(r.missingEntries.length, 2);
});

test('wiping the whole directory — receipts included — degrades to NO DATA, never VERIFIED', () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  store.ensure();
  const r = verify();
  assert.equal(r.verdict, 'NO DATA');
  assert.equal(r.noData, true);
});
