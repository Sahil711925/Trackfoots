'use strict';
/**
 * server.js — tiny zero-dependency server so the demo is a browser tab, not a terminal.
 *   GET  /                 the UI
 *   GET  /api/state        logs + anchors + verdict
 *   POST /api/verify       re-run the audit
 *   POST /api/attack       { mode: 'naive'|'smart', batch: 3 }
 *   POST /api/reset        wipe, reseed, re-anchor
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const { verify } = require('./lib/verify');
const { attack } = require('./lib/attack');
const { seed } = require('./lib/seed');
const { anchorAll } = require('./scripts/anchor');
const { buildProof } = require('./lib/proof');
const { buildBundle } = require('./lib/bundle');
const { checkChainOfCheckpoints } = require('./lib/consistency');

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;

/**
 * One mutation at a time.
 * Two concurrent resets used to interleave: the second wiped data/ while the first was
 * still anchoring, leaving a ledger that pointed at batches whose entries no longer existed.
 * That is exactly what "Reset demo did not go green" looked like.
 */
let busy = false;

async function withLock(res, fn) {
  if (busy) return json(res, 409, { error: 'another operation is still running — wait a second and try again' });
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

function state() {
  const logs = store.readLogs();
  const entries = logs
    .filter((r) => r.ok)
    .map((r) => r.entry)
    .slice(-250)
    .reverse();
  const ledger = store.readLedger();
  const chainExpected = String(process.env.ANCHOR_ON_CHAIN || '').toLowerCase() === 'true';
  const onChain = ledger.filter((b) => b.chain !== 'LOCAL-SIMULATED').length;
  let consistency = { ok: true, verifiedPairs: 0, totalPairs: 0 };
  try {
    const c = checkChainOfCheckpoints();
    consistency = { ok: c.ok, verifiedPairs: c.verifiedPairs, totalPairs: c.totalPairs };
  } catch (err) {
    consistency = { ok: false, verifiedPairs: 0, totalPairs: 0, error: err.message };
  }
  return {
    entries,
    total: logs.length,
    ledger: ledger.slice().reverse(),
    consistency,
    chain: {
      expected: chainExpected,
      network: process.env.CHAIN || null,
      onChain,
      total: ledger.length,
      degraded: chainExpected && ledger.length > 0 && onChain === 0,
      dataDir: store.DATA,
    },
    report: verify(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
    // no-store: otherwise the browser silently serves a cached copy and edits never appear
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());

  if (req.method === 'GET' && (url.pathname === '/api/consistency' || url.pathname === '/api/append-only')) {
    try {
      return json(res, 200, checkChainOfCheckpoints());
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // inclusion proof for one entry: proves it belonged to a published batch
  if (req.method === 'GET' && url.pathname === '/api/proof') {
    const seq = Number(url.searchParams.get('seq'));
    try {
      const proof = buildProof(seq);
      return json(res, proof ? 200 : 404, proof || { error: `no proof for entry ${seq}` });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // printable evidence bundle for one entry
  if (req.method === 'POST' && url.pathname === '/api/bundle') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () =>
      withLock(res, async () => {
        try {
          const { seq } = body ? JSON.parse(body) : {};
          const out = await buildBundle(Number(seq));
          return json(res, 200, { path: out.path, url: `/bundle/${seq}` });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      })
    );
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/bundle/')) {
    const seq = Number(url.pathname.split('/').pop());
    try {
      const out = await buildBundle(seq);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(out.html);
    } catch (err) {
      return json(res, 404, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/verify') return json(res, 200, { report: verify() });

  if (req.method === 'POST' && url.pathname === '/api/attack') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () =>
      withLock(res, () => {
        try {
          const { mode = 'smart', batch = 3 } = body ? JSON.parse(body) : {};
          const result = attack(mode, batch);
          return json(res, 200, { result, ...state() });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      })
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    return withLock(res, async () => {
      fs.rmSync(store.DATA, { recursive: true, force: true });
      store.ensure();
      seed(1200);
      await anchorAll({ verbose: false });
      return json(res, 200, state());
    });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\n  TRACKFOOTS demo  ->  http://localhost:${PORT}\n`);
});
