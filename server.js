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

const PORT = Number(process.env.PORT || 5173);
const ROOT = __dirname;

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
  return {
    entries,
    total: logs.length,
    ledger: store.readLedger().slice().reverse(),
    report: verify(),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());

  if (req.method === 'POST' && url.pathname === '/api/verify') return json(res, 200, { report: verify() });

  if (req.method === 'POST' && url.pathname === '/api/attack') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { mode = 'smart', batch = 3 } = body ? JSON.parse(body) : {};
        const result = attack(mode, batch);
        return json(res, 200, { result, ...state() });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    fs.rmSync(store.DATA, { recursive: true, force: true });
    store.ensure();
    seed(1200);
    await anchorAll({ verbose: false });
    return json(res, 200, state());
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\n  WITNESS demo  ->  http://localhost:${PORT}\n`);
});
