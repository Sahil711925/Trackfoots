'use strict';
/**
 * tenants.js (CLI) — run one deployment as several companies, one process each.
 *
 *   node scripts/tenants.js up [name...]     start every tenant (or just the named ones)
 *   node scripts/tenants.js down             stop everything recorded in the pidfile
 *   node scripts/tenants.js status           entry/batch counts per tenant, straight from /api/stats
 *   node scripts/tenants.js seed <name> [n]  seed (and anchor) one tenant
 *
 * Each child is `node server.js` with its own PORT, WITNESS_DATA, INGEST_KEY and ORG, so the
 * core modules are untouched: store.js already resolves its paths from WITNESS_DATA at require
 * time, and server.js already reads PORT / INGEST_KEY / ORG from the environment.
 *
 * Two things this file exists to get right:
 *   1. `WITNESS_TEST=1` in every child. lib/env.js force-loads WITNESS_DATA and INGEST_KEY from
 *      .env, which would silently put every tenant on the single-tenant data dir. The escape
 *      hatch is what makes the per-tenant env actually win. Proof is printed by `up`.
 *   2. Real shutdown. Children are recorded in data/tenants/pids.json, and SIGINT/SIGTERM stops
 *      every one of them — otherwise ports 5174/5175 stay bound and the next run looks broken.
 */
require('../lib/env');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const T = require('../lib/tenants');

const ROOT = path.join(__dirname, '..');
const TENANTS_DIR = path.join(ROOT, 'data', 'tenants');
const PIDFILE = path.join(TENANTS_DIR, 'pids.json');
const DEFAULT_SEED = 250;
const READY_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------- helpers

function ensureDirs() {
  fs.mkdirSync(TENANTS_DIR, { recursive: true });
}

function logPath(tenant) {
  return path.join(TENANTS_DIR, `${tenant.name}.log`);
}

function readPidfile() {
  if (!fs.existsSync(PIDFILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PIDFILE, 'utf8'));
  } catch {
    return null;
  }
}

function writePidfile(entries) {
  ensureDirs();
  fs.writeFileSync(PIDFILE, JSON.stringify({ startedAt: new Date().toISOString(), tenants: entries }, null, 2) + '\n');
}

/**
 * Best-effort, never throws. On Windows a concurrent `down` can be deleting the same file, and
 * rmSync reports EPERM for that moment. A leftover pidfile is harmless: `up` checks every pid
 * for liveness before refusing to start.
 */
function removePidfile() {
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(PIDFILE, { force: true });
      return true;
    } catch {
      /* retry: the handle may still be closing */
    }
  }
  return false;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function killPid(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDeath(pid, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

function request(port, route, { method = 'GET', body, key, timeout = 2000 } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (key) headers['x-api-key'] = key;
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers, timeout, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => resolve({ status: 0, json: null, text: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForStats(port, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    const res = await request(port, '/api/stats', { timeout: 1200 });
    if (res.status === 200 && res.json && typeof res.json.entries === 'number') return res.json;
    last = res.status ? `HTTP ${res.status}` : res.text;
    await sleep(150);
  }
  throw new Error(`tenant on port ${port} did not answer /api/stats within ${timeoutMs}ms (${last})`);
}

function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(600, () => done(false));
  });
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Ask the child's own module graph where store.DATA points. This is the isolation proof. */
function storeDataDir(env) {
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./lib/store').DATA)"], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (r.status !== 0) return `(probe failed: ${(r.stderr || '').trim().split('\n').pop()})`;
  return (r.stdout || '').trim();
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => '  ' + cells.map((c, i) => pad(c, widths[i])).join('  ');
  console.log(line(headers));
  console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

// ---------------------------------------------------------------- seed / anchor

function seedTenant(tenant, count) {
  fs.mkdirSync(T.dataDirOf(tenant, ROOT), { recursive: true });
  const env = T.buildChildEnv(tenant, { root: ROOT });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed.js'), String(count)], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0) {
    throw new Error(`seeding ${tenant.name} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return count;
}

/**
 * Publish the tenant's own Merkle roots. Best effort: if the chain is unreachable, anchorAll()
 * keeps the roots in the tenant's own ledger and says so — it must not fail `up`.
 */
function anchorTenant(tenant) {
  const env = T.buildChildEnv(tenant, { root: ROOT });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'anchor.js')], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 45000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const last = out.split('\n').filter(Boolean).pop() || 'no output';
  return { ok: r.status === 0, message: last };
}

// ---------------------------------------------------------------- up

async function up(opts = {}) {
  const registry = T.assertValidRegistry(T.loadRegistry(T.registryPath(ROOT)), { root: ROOT });
  const wanted = opts.names && opts.names.length
    ? opts.names.map((n) => T.requireTenant(registry, n))
    : registry.tenants;

  // Fail before spawning anything: a half-started fleet is worse than a clean error.
  const plan = [];
  const problems = [];
  for (const tenant of wanted) {
    try {
      const env = T.buildChildEnv(tenant, { root: ROOT });
      plan.push({ tenant, env, key: env.INGEST_KEY });
    } catch (err) {
      problems.push(err.message);
    }
  }
  if (problems.length) throw new Error(problems.join('\n'));

  const previous = readPidfile();
  const running = previous && Array.isArray(previous.tenants) ? previous.tenants.filter((t) => isAlive(t.pid)) : [];
  if (running.length) {
    throw new Error(
      `tenants already running (${running.map((t) => `${t.name}:${t.pid}`).join(', ')}) — run: node scripts/tenants.js down`
    );
  }
  if (previous) removePidfile();

  const busy = [];
  for (const { tenant } of plan) if (await portBusy(tenant.port)) busy.push(`${tenant.name}:${tenant.port}`);
  if (busy.length) throw new Error(`port(s) already in use: ${busy.join(', ')} — stop that process first`);

  ensureDirs();

  const seedCount = opts.seed === undefined ? DEFAULT_SEED : opts.seed;
  const children = [];
  let stopping = false;

  const stopAll = async (code) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) {
      if (isAlive(c.child.pid)) killPid(c.child.pid, 'SIGTERM');
    }
    for (const c of children) {
      if (!(await waitForDeath(c.child.pid, 4000))) killPid(c.child.pid, 'SIGKILL');
      try {
        c.out.end();
      } catch { /* already closed */ }
    }
    removePidfile();
    console.log(`\n  stopped ${children.length} tenant(s)`);
    process.exit(code);
  };

  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  try {
    for (const { tenant, env } of plan) {
      const dir = T.dataDirOf(tenant, ROOT);
      fs.mkdirSync(dir, { recursive: true });
      const logs = path.join(dir, 'logs.jsonl');

      if (seedCount > 0 && countLines(logs) === 0) {
        process.stdout.write(`  ${pad(tenant.name, 10)} seeding ${seedCount} entries… `);
        seedTenant(tenant, seedCount);
        const a = opts.anchor === false ? { message: 'anchoring skipped (--no-anchor)' } : anchorTenant(tenant);
        console.log(a.message);
      }
    }

    for (const { tenant, env } of plan) {
      const out = fs.createWriteStream(logPath(tenant), { flags: 'a' });
      const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      children.push({ child, out, tenant });

      child.on('exit', (code, signal) => {
        if (stopping) return;
        console.log(`  ! ${tenant.name} exited (code ${code}, signal ${signal}) — see ${path.relative(ROOT, logPath(tenant))}`);
        if (children.every((c) => !isAlive(c.child.pid))) stopAll(1);
      });
      child.on('error', (err) => {
        console.log(`  ! ${tenant.name} failed to spawn: ${err.message}`);
      });
    }

    const stats = new Map();
    for (const { tenant } of plan) stats.set(tenant.name, await waitForStats(tenant.port));

    if (!stopping) {
      writePidfile(
        plan.map(({ tenant, key }) => ({
          name: tenant.name,
          port: tenant.port,
          org: tenant.org || tenant.name,
          dataDir: T.dataDirOf(tenant, ROOT),
          url: T.urlOf(tenant),
          keyEnv: tenant.keyEnv,
          pid: children.find((c) => c.tenant.name === tenant.name).child.pid,
          log: logPath(tenant),
        }))
      );
    }

    console.log('');
    table(
      plan.map(({ tenant, key }) => {
        const s = stats.get(tenant.name);
        return [tenant.name, tenant.port, key, T.urlOf(tenant), s.entries, s.batches];
      }),
      ['tenant', 'port', 'ingest key (x-api-key)', 'url', 'entries', 'batches']
    );

    // ---- proof, not hand-waving: where does each child actually write? ----
    console.log('\n  isolation');
    for (const { tenant, env } of plan) {
      const dir = T.dataDirOf(tenant, ROOT);
      const actual = storeDataDir(env);
      const same = path.resolve(actual).toLowerCase() === path.resolve(dir).toLowerCase();
      console.log(`    ${pad(tenant.name, 9)} store.DATA = ${actual}${same ? '' : '   <-- MISMATCH, expected ' + dir}`);
      console.log(
        `    ${' '.repeat(9)} logs.jsonl ${fileSize(path.join(dir, 'logs.jsonl'))} B   ` +
          `ledger.jsonl ${fileSize(path.join(dir, 'ledger.jsonl'))} B   ` +
          `receipts.jsonl ${fileSize(path.join(dir, 'auditor', 'receipts.jsonl'))} B`
      );
    }
    const dirs = plan.map(({ tenant }) => path.resolve(T.dataDirOf(tenant, ROOT)).toLowerCase());
    console.log(`    ${new Set(dirs).size === dirs.length ? 'distinct data dirs: yes' : 'distinct data dirs: NO — ABORT'}`);
    console.log(`\n  logs: ${path.relative(ROOT, TENANTS_DIR)}/<tenant>.log    pids: ${path.relative(ROOT, PIDFILE)}`);
    console.log('  Ctrl+C stops every tenant.\n');

    if (stopping) return;
    // Stay in the foreground so the children outlive this call and stay under one Ctrl+C.
    await new Promise(() => {});
  } catch (err) {
    for (const c of children) if (isAlive(c.child.pid)) killPid(c.child.pid, 'SIGTERM');
    removePidfile();
    throw err;
  }
}

// ---------------------------------------------------------------- down / status / seed

async function down() {
  const file = readPidfile();
  if (!file || !Array.isArray(file.tenants) || file.tenants.length === 0) {
    console.log('no tenants recorded — nothing to stop');
    return;
  }

  const rows = [];
  for (const t of file.tenants) {
    if (!isAlive(t.pid)) {
      rows.push([t.name, t.port, t.pid, 'already stopped']);
      continue;
    }
    killPid(t.pid, 'SIGTERM');
    let dead = await waitForDeath(t.pid, 4000);
    if (!dead) {
      killPid(t.pid, 'SIGKILL');
      dead = await waitForDeath(t.pid, 2000);
    }
    rows.push([t.name, t.port, t.pid, dead ? 'stopped' : 'STILL RUNNING']);
  }

  table(rows, ['tenant', 'port', 'pid', 'result']);
  removePidfile();
}

async function status() {
  const registry = T.assertValidRegistry(T.loadRegistry(T.registryPath(ROOT)), { root: ROOT });
  const rows = [];
  for (const tenant of registry.tenants) {
    const res = await request(tenant.port, '/api/stats', { timeout: 1500 });
    if (res.status === 200 && res.json) {
      rows.push([
        tenant.name,
        tenant.port,
        'up',
        res.json.entries,
        res.json.batches,
        res.json.unanchored,
        T.urlOf(tenant),
      ]);
    } else {
      rows.push([tenant.name, tenant.port, 'down', '-', '-', '-', T.urlOf(tenant)]);
    }
  }
  console.log('');
  table(rows, ['tenant', 'port', 'state', 'entries', 'batches', 'unanchored', 'url']);
  const upCount = rows.filter((r) => r[2] === 'up').length;
  console.log(`\n  ${upCount}/${rows.length} tenants reachable.  logs: ${path.relative(ROOT, TENANTS_DIR)}/<tenant>.log\n`);
}

function seed(name, count) {
  const registry = T.assertValidRegistry(T.loadRegistry(T.registryPath(ROOT)), { root: ROOT });
  const tenant = T.requireTenant(registry, name);
  const n = Number.isInteger(count) && count > 0 ? count : DEFAULT_SEED;
  fs.mkdirSync(T.dataDirOf(tenant, ROOT), { recursive: true });
  const before = countLines(path.join(T.dataDirOf(tenant, ROOT), 'logs.jsonl'));
  seedTenant(tenant, n);
  const after = countLines(path.join(T.dataDirOf(tenant, ROOT), 'logs.jsonl'));
  const a = anchorTenant(tenant);
  console.log(
    `  ${tenant.name}: seeded ${n} (${before} -> ${after} entries) in ${path.relative(ROOT, T.dataDirOf(tenant, ROOT))}\n` +
      `  ${a.message}`
  );
  if (before > 0) console.log('  note: seeded on top of an existing tenant log — the chain continues, nothing is reset');
}

// ---------------------------------------------------------------- CLI

function usage() {
  console.log(
    [
      'usage: node scripts/tenants.js <command>',
      '',
      '  up [name...]    start one server per tenant, seed if empty, print the isolation proof',
      '                  --seed=N (default 250, 0 = do not seed)   --no-anchor',
      '  down            stop every tenant recorded in data/tenants/pids.json',
      '  status          entry/batch counts per tenant from /api/stats',
      '  seed <name> [n] seed one tenant and publish its roots',
      '',
      'ingest keys come from each tenant\'s keyEnv (see tenants.json), e.g. INGEST_KEY_ACME.',
    ].join('\n')
  );
}

async function main(argv) {
  const [cmd = 'status', ...rest] = argv;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();

  if (cmd === 'up') {
    const names = rest.filter((a) => !a.startsWith('--'));
    const seedFlag = rest.find((a) => a.startsWith('--seed='));
    const opts = { names, anchor: !rest.includes('--no-anchor') };
    if (seedFlag) {
      const n = Number(seedFlag.split('=')[1]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--seed must be a non-negative integer (got ${seedFlag})`);
      opts.seed = n;
    }
    return up(opts);
  }

  if (cmd === 'down') return down();

  if (cmd === 'status') return status();

  if (cmd === 'seed') {
    const name = rest[0];
    if (!name) throw new Error('usage: node scripts/tenants.js seed <name> [count]');
    const n = rest[1] === undefined ? undefined : Number(rest[1]);
    if (rest[1] !== undefined && (!Number.isInteger(n) || n <= 0)) {
      throw new Error(`count must be a positive integer (got ${rest[1]})`);
    }
    return seed(name, n);
  }

  usage();
  throw new Error(`unknown command "${cmd}"`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`\n  error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { up, down, status, seed, main, PIDFILE, TENANTS_DIR };
