'use strict';
/**
 * api.test.js — server.js HTTP endpoints.
 *
 * Boots the real server on a non-standard port (5399) against an isolated temp data dir,
 * then drives the demo the way the browser does: state -> verify -> per-entry proof ->
 * attack -> reset, asserting status codes and that the verdict really flips
 * VERIFIED -> TAMPERED -> VERIFIED.
 *
 * server.js binds at require time and does not export the http.Server, so http.createServer
 * is wrapped for the duration of that require to capture the instance. after() closes it,
 * otherwise the open handle keeps the test process alive and the run hangs.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const PORT = 5399;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), `witness-test-api-${process.pid}-${Date.now()}`);

process.env.PORT = String(PORT);
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const store = require(path.join(REPO, 'lib', 'store.js'));
const { merkleRoot } = require(path.join(REPO, 'lib', 'merkle.js'));

// Capture the server instance without touching server.js.
let srv = null;
const realCreateServer = http.createServer;
http.createServer = (...args) => {
  srv = realCreateServer.apply(http, args);
  return srv;
};
require(path.join(REPO, 'server.js'));
http.createServer = realCreateServer;

// server.js pulls in scripts/anchor -> lib/env, which forces ANCHOR_ON_CHAIN=true from
// .env. Reset both keys so any anchoring done through the API stays local and in-temp.
process.env.WITNESS_DATA = DATA;
process.env.ANCHOR_ON_CHAIN = 'false';

async function api(method, route, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + route, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

before(async () => {
  assert.ok(srv, 'server.js must have created an http server');
  if (!srv.listening) {
    await Promise.race([
      once(srv, 'listening'),
      once(srv, 'error').then(([err]) => {
        throw err;
      }),
    ]);
  }
  assert.equal(srv.address().port, PORT, 'must bind the test port, not 5173');
});

after(async () => {
  if (srv && srv.listening) await new Promise((resolve) => srv.close(resolve));
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('POST /api/reset seeds and anchors in the temp data dir and reports VERIFIED', async () => {
  const { status, json } = await api('POST', '/api/reset');
  assert.equal(status, 200);
  assert.ok(json, 'reset must return JSON');
  assert.equal(json.report.verdict, 'VERIFIED');
  assert.equal(json.total, 1200);
  assert.equal(json.ledger.length, 12);
  assert.equal(json.chain.dataDir, DATA, 'server must be reading the isolated temp dir');
  assert.equal(json.chain.expected, false, 'anchoring must be local during tests');
  assert.equal(json.chain.onChain, 0);
});

test('GET /api/state returns entries, ledger, chain info and a VERIFIED report', async () => {
  const { status, json } = await api('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(json.total, 1200);
  assert.equal(json.entries.length, 250, 'state is capped at the newest 250 entries');
  assert.equal(json.entries[0].seq, 1200, 'newest entry comes first');
  assert.equal(json.ledger.length, 12);
  assert.equal(json.ledger[0].batch, 12, 'ledger is returned newest-first');
  assert.equal(json.chain.dataDir, DATA);
  assert.equal(json.report.verdict, 'VERIFIED');
  assert.equal(json.report.entriesOnDisk, 1200);
  assert.equal(json.report.batchesPublished, 12);
});

test('POST /api/verify re-runs the audit and still says VERIFIED', async () => {
  const { status, json } = await api('POST', '/api/verify');
  assert.equal(status, 200);
  assert.equal(json.report.verdict, 'VERIFIED');
  assert.equal(json.report.chainOk, true);
  assert.deepEqual(json.report.badBatches, []);
  assert.deepEqual(json.report.missingEntries, []);
});

test('GET /api/proof?seq=1 returns a 7-step proof that rebuilds the published root', async () => {
  const { status, json } = await api('GET', '/api/proof?seq=1');
  assert.equal(status, 200);
  assert.equal(json.seq, 1);
  assert.equal(json.verified, true);
  assert.equal(json.hashMatches, true);
  assert.equal(json.proofLength, 7);
  assert.equal(json.proofSteps.length, 7);
  assert.equal(json.leafCount, 100);
  assert.equal(json.batchRange, '1-100');

  const ledger = store.readLedger();
  assert.equal(json.publishedRoot, ledger.find((b) => b.batch === 1).root);
  assert.equal(json.rebuiltRoot, json.publishedRoot);
});

test('GET /api/proof with an unknown or malformed seq returns 404', async () => {
  const missing = await api('GET', '/api/proof?seq=99999');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /no proof for entry 99999/i);

  const malformed = await api('GET', '/api/proof?seq=abc');
  assert.equal(malformed.status, 404);
  assert.match(malformed.json.error, /no proof/i);
});

test('POST /api/attack flips VERIFIED -> TAMPERED, and /api/reset restores VERIFIED', async () => {
  const attacked = await api('POST', '/api/attack', { mode: 'smart', batch: 3 });
  assert.equal(attacked.status, 200);
  assert.equal(attacked.json.result.mode, 'smart');
  assert.equal(attacked.json.result.batch, 3);
  assert.ok(attacked.json.result.deleted > 0, 'the attack must actually delete entries');
  assert.equal(attacked.json.report.verdict, 'TAMPERED', 'a renumbered, root-broken log must be TAMPERED');
  assert.equal(attacked.json.report.chainOk, true, 'smart mode leaves a self-consistent chain');
  assert.ok(attacked.json.report.badBatches.length > 0, 'the published root check is what catches it');

  // A fresh read must agree with what the attack returned.
  const state = await api('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.report.verdict, 'TAMPERED');
  assert.ok(state.json.total < 1200, 'entries were deleted');

  const proofGone = await api('GET', '/api/proof?seq=205');
  assert.equal(proofGone.status, 404, 'a deleted entry has no proof');

  const reset = await api('POST', '/api/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.json.report.verdict, 'VERIFIED', 'reset must wipe, reseed and re-anchor');

  const afterReset = await api('GET', '/api/state');
  assert.equal(afterReset.json.report.verdict, 'VERIFIED');
  assert.equal(afterReset.json.total, 1200);
});

test('an unknown route returns 404 JSON', async () => {
  const { status, json, headers } = await api('GET', '/api/nope');
  assert.equal(status, 404);
  assert.match(headers.get('content-type'), /application\/json/);
  assert.equal(json.error, 'not found');
});
