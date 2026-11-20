'use strict';
/**
 * alerts.test.js — a detection that nobody hears about is a log line, not a control.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-alerts-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.WITNESS_TEST = '1';
process.env.ANCHOR_ON_CHAIN = 'false';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const alerts = require(path.join(REPO, 'lib', 'alerts.js'));

before(() => store.ensure());
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('raises an alert and records it', () => {
  const rec = alerts.raise('tamper-detected', '3 entries deleted', { batch: 3, deleted: 3 });
  assert.equal(rec.type, 'tamper-detected');
  assert.equal(rec.severity, 'high');
  assert.equal(rec.dispatched, true);

  const list = alerts.recent(10);
  assert.equal(list.length, 1);
  assert.equal(list[0].message, '3 entries deleted');
  assert.equal(list[0].detail.deleted, 3);
});

test('repeats inside a minute are recorded but not re-dispatched', () => {
  const second = alerts.raise('tamper-detected', 'again', { deleted: 3 });
  assert.equal(second.dispatched, false, 'the one-per-minute guard must suppress the page');

  const list = alerts.recent(10);
  assert.equal(list.length, 2, 'both are still written to the alert log');
  assert.equal(list[0].dispatched, false);
});

test('a different type dispatches immediately', () => {
  const other = alerts.raise('liveness-stale', 'no anchor for 400 entries', { severity: 'critical' });
  assert.equal(other.dispatched, true);
  assert.equal(alerts.recent(1)[0].type, 'liveness-stale');
});

test('recent() returns newest first and respects the limit', () => {
  const list = alerts.recent(2);
  assert.equal(list.length, 2);
  assert.ok(new Date(list[0].ts) >= new Date(list[1].ts));
});
