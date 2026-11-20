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
const { seedReal } = require('./lib/seed-real');
const { anchorAll } = require('./scripts/anchor');
const { buildProof } = require('./lib/proof');
const { buildBundle } = require('./lib/bundle');
const { checkChainOfCheckpoints } = require('./lib/consistency');
const { verifyPayload } = require('./lib/auditor');
const { ingest, MAX_BATCH } = require('./lib/ingest');
const alerts = require('./lib/alerts');

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
    alerts: alerts.recent(5),
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

  // Marketing page at the root; the product itself lives at /app.
  if (req.method === 'GET' && url.pathname === '/') {
    const file = path.join(ROOT, 'public', 'landing.html');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' });
      return res.end(fs.readFileSync(file));
    }
  }

  if (req.method === 'GET' && (url.pathname === '/app' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
    // no-store: otherwise the browser silently serves a cached copy and edits never appear
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' });
    return res.end(html);
  }

  // Fonts and artwork for the landing page. Extension whitelist + traversal guard: this serves
  // two directories, not the whole filesystem.
  if (req.method === 'GET' && (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/img/'))) {
    const PUBLIC = path.join(ROOT, 'public');
    const file = path.join(PUBLIC, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    const TYPES = {
      '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
    };
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!file.startsWith(PUBLIC) || !type || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=600' });
    return res.end(fs.readFileSync(file));
  }

  // One image the landing page needs. Kept explicit rather than serving a directory.
  if (req.method === 'GET' && url.pathname === '/dashboard.png') {
    const file = path.join(ROOT, 'public', 'dashboard.png');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' });
    return res.end(fs.readFileSync(file));
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state());

  /**
   * The write path an application actually uses.
   * Requires x-api-key when INGEST_KEY is configured; returns a signed receipt per accepted line.
   */
  if (req.method === 'POST' && (url.pathname === '/api/log' || url.pathname === '/api/ingest')) {
    const expected = process.env.INGEST_KEY;
    if (!expected) return json(res, 503, { error: 'ingest disabled: set INGEST_KEY in the environment' });
    const given = req.headers['x-api-key'];
    if (!given || given !== expected) return json(res, 401, { error: 'invalid or missing x-api-key' });

    let body = '';
    let tooBig = false;
    req.on('data', (c) => {
      body += c;
      if (body.length > 2_000_000) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () =>
      withLock(res, () => {
        if (tooBig) return json(res, 413, { error: 'request body too large (2 MB)' });
        try {
          const payload = body ? JSON.parse(body) : {};
          const result = ingest(payload);
          return json(res, result.accepted ? 202 : 400, { ...result, maxBatch: MAX_BATCH, ...state() });
        } catch (err) {
          return json(res, 400, { error: err.message, maxBatch: MAX_BATCH });
        }
      })
    );
    return;
  }

  // Demo emitter: lets the presenter push a real line through the authenticated ingest path
  // without pasting a key on stage. Localhost only — never exposed off-box.
  if (req.method === 'POST' && url.pathname === '/api/demo/emit') {
    const ip = req.socket.remoteAddress || '';
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return json(res, 403, { error: 'localhost only' });
    const lines = [
      { actor: 'rahul', action: 'ssh login accepted', meta: { ip: '103.21.44.9', port: 51234, method: 'publickey' } },
      { actor: 'priya', action: 'sudo /bin/cat /etc/shadow', meta: { ip: '103.21.44.31', tty: 'pts/2' } },
      { actor: 'arjun', action: 'GET /api/orders/1182 200', meta: { ip: '49.36.7.201', status: 200 } },
      { actor: 'meera', action: 'ssh login failed', meta: { ip: '185.220.101.7', attempts: 4 } },
    ];
    const pick = lines[Math.floor(Math.random() * lines.length)];
    try {
      const result = ingest(pick);
      return json(res, 202, { line: pick, ...result });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (req.method === 'GET' && (url.pathname === '/api/incident-report' || url.pathname === '/incident')) {
    const { build } = require('./lib/incident-report');
    const chain = { address: (() => { try { const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments.json'), 'utf8')); const k = process.env.CHAIN || 'local'; return (d[k] || Object.values(d)[0] || {}).address; } catch { return null; } })(), network: process.env.CHAIN || 'local' };
    const { html } = build(state().report, chain, store.readLedger(), process.env.ORG || 'Trackfoots');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/status.html')) {
    const file = path.join(ROOT, 'public', 'status.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('status page not built yet');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }

  /**
   * Paginated, filterable entry list — the data source for search in the UI and for the public
   * status page. Newest first, so offset 0 is the most recent line.
   */
  if (req.method === 'GET' && url.pathname === '/api/entries') {
    const all = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const actor = url.searchParams.get('actor');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    let list = all;
    if (actor) list = list.filter((e) => e.actor === actor);
    if (from) list = list.filter((e) => e.ts >= from);
    if (to) list = list.filter((e) => e.ts <= to);
    if (q) {
      list = list.filter((e) =>
        `${e.actor} ${e.action} ${JSON.stringify(e.meta || {})}`.toLowerCase().includes(q)
      );
    }

    const total = list.length;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
    const newestFirst = list.slice().reverse();

    return json(res, 200, {
      total,
      matched: total,
      offset,
      limit,
      entries: newestFirst.slice(offset, offset + limit),
      filters: { q: q || null, actor: actor || null, from: from || null, to: to || null },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/alerts') {
    return json(res, 200, { alerts: alerts.recent(50), webhook: Boolean(process.env.ALERT_WEBHOOK) });
  }

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const logs = store.readLogs().filter((r) => r.ok).map((r) => r.entry);
    const ledger = store.readLedger();
    const last = ledger[ledger.length - 1];
    return json(res, 200, {
      entries: logs.length,
      batches: ledger.length,
      unanchored: last ? logs.filter((e) => e.seq > last.toSeq).length : logs.length,
      oldest: logs.length ? logs[0].ts : null,
      newest: logs.length ? logs[logs.length - 1].ts : null,
      ingest: { endpoint: '/api/log', auth: 'x-api-key', maxBatch: MAX_BATCH, enabled: Boolean(process.env.INGEST_KEY) },
    });
  }

  if (req.method === 'GET' && url.pathname === '/auditor') {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'auditor.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  // The auditor verifies a bundle against the chain. It deliberately does not read data/.
  if (req.method === 'GET' && url.pathname === '/api/auditor/latest') {
    try {
      const dir = path.join(ROOT, 'exports');
      if (!fs.existsSync(dir)) return json(res, 404, { error: 'no exports directory yet' });
      const files = fs
        .readdirSync(dir)
        .filter((f) => /^bundle-\d+\.json$/.test(f))
        .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
      if (!files.length) return json(res, 404, { error: 'no bundle exported yet — run: npm run bundle -- 250' });
      const payload = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      return json(res, 200, { file: files[0], payload });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auditor/verify') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { payload } = JSON.parse(body || '{}');
        let readChainRoot = null;
        try {
          const chain = require('./lib/chain');
          if (chain.readDeployment()) readChainRoot = (seq) => chain.readRoot(seq);
        } catch { /* chain optional */ }
        const out = await verifyPayload(payload, { readChainRoot });
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/forge-receipt') {
    return withLock(res, () => {
      try {
        const receiptsLib = require('./lib/receipts');
        const { sha256 } = require('./lib/merkle');
        const lines = store.readLogs().filter((r) => r.ok);
        if (!lines.length) return json(res, 400, { error: 'no entries to forge a receipt for' });
        const victim = lines[Math.floor(Math.random() * lines.length)].entry;

        // A receipt for content that does not exist, signed with a key the attacker chose.
        const forged = receiptsLib.makeForged({
          seq: victim.seq + 100000,
          chash: sha256('content-the-attacker-invented'),
          ts: new Date().toISOString(),
        });
        fs.appendFileSync(store.RECEIPTS, JSON.stringify(forged) + '\n');
        return json(res, 200, state());
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    });
  }

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
          const st = state();
          if (st.report.verdict !== 'VERIFIED') {
            alerts.raise(
              'tamper-detected',
              `${result.deleted} entries deleted and ${result.edited} rewritten in batch ${result.batch}`,
              { severity: 'critical', batch: result.batch, deleted: result.deleted, edited: result.edited, mode: result.mode }
            );
          }
          return json(res, 200, { result, ...st });
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
      // Real-format lines by default: the demo should look like a server, not a fixture.
      // lib/seed-real falls back to synthetic entries if samples/ is missing.
      seedReal(1200);
      await anchorAll({ verbose: false });
      return json(res, 200, state());
    });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`\n  TRACKFOOTS demo  ->  http://localhost:${PORT}\n`);
});
