'use strict';
/**
 * tenants.test.js — the registry contract, and the claim that matters: two tenants cannot see
 * each other's logs.
 *
 * The integration half boots TWO real `node server.js` processes on ephemeral ports, each with
 * its own temp data directory and its own ingest key, then proves independence from the outside:
 *
 *   - each child's own store.DATA resolves to its own directory (this is the check that fails if
 *     WITNESS_TEST=1 is missing, because lib/env.js would reload WITNESS_DATA/INGEST_KEY from .env)
 *   - an entry posted with tenant A's key is visible on A and nowhere on B (and vice versa)
 *   - tenant A's key is rejected by tenant B with 401
 *   - the files on disk contain only their own marker
 *
 * Children are killed in teardown; a leaked child would keep the test process alive.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');
const T = require(path.join(REPO, 'lib', 'tenants.js'));

const load = () => T.loadRegistry(T.registryPath(REPO));
const clone = (x) => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------------ registry

test('tenants.json is a valid registry with two isolated tenants on 5174/5175', () => {
  const registry = load();
  const result = T.validateRegistry(registry, { root: REPO });

  assert.equal(result.ok, true, `registry errors:\n${result.errors.join('\n')}`);
  assert.equal(registry.tenants.length, 2);

  const [acme, fintech] = registry.tenants;
  assert.equal(acme.name, 'acme');
  assert.equal(acme.port, 5174);
  assert.equal(fintech.name, 'fintech');
  assert.equal(fintech.port, 5175);

  assert.notEqual(T.dataDirOf(acme, REPO), T.dataDirOf(fintech, REPO));
  assert.notEqual(acme.keyEnv, fintech.keyEnv);
  for (const tenant of registry.tenants) {
    // never the base data dir, always under data/tenants
    assert.notEqual(path.resolve(T.dataDirOf(tenant, REPO)), path.join(REPO, 'data'));
    assert.match(T.dataDirOf(tenant, REPO), /[\\/]data[\\/]tenants[\\/]/);
    assert.equal(T.describe(tenant, REPO).url, `http://127.0.0.1:${tenant.port}`);
  }
});

test('validation rejects duplicate names, ports, dataDirs and keyEnv', () => {
  const registry = load();
  const base = clone(registry.tenants);

  const cases = [
    ['duplicate name', { ...base[1], name: base[0].name, port: 5201, dataDir: 'data/tenants/x', keyEnv: 'INGEST_KEY_X' }, /duplicate tenant name/i],
    ['duplicate port', { ...base[1], name: 'third', port: base[0].port, dataDir: 'data/tenants/x', keyEnv: 'INGEST_KEY_X' }, /duplicate port/i],
    ['duplicate dataDir', { ...base[1], name: 'third', port: 5202, dataDir: base[0].dataDir, keyEnv: 'INGEST_KEY_X' }, /duplicate dataDir/i],
    ['duplicate keyEnv', { ...base[1], name: 'third', port: 5203, dataDir: 'data/tenants/x', keyEnv: base[0].keyEnv }, /duplicate keyEnv/i],
  ];

  for (const [label, extra, re] of cases) {
    const bad = { tenants: [base[0], extra] };
    const result = T.validateRegistry(bad, { root: REPO });
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.match(result.errors.join('\n'), re, `${label} error was: ${result.errors.join('; ')}`);
    assert.throws(() => T.assertValidRegistry(bad, { root: REPO }), re);
  }
});

test('validation rejects a dataDir equal to the base data dir', () => {
  const registry = load();

  for (const dataDir of ['data', 'data/', './data', 'data/tenants/..']) {
    const bad = { tenants: [{ ...registry.tenants[0], dataDir }] };
    const result = T.validateRegistry(bad, { root: REPO });
    assert.equal(result.ok, false, `dataDir "${dataDir}" must not be accepted`);
    assert.match(result.errors.join('\n'), /base data dir/i, `for ${dataDir}: ${result.errors.join('; ')}`);
  }
});

test('validation rejects absolute/escaping dataDirs, bad ports and missing fields', () => {
  const t0 = load().tenants[0];

  const badDir = (dataDir) => T.validateRegistry({ tenants: [{ ...t0, dataDir }] }, { root: REPO });
  assert.equal(badDir(path.join(REPO, 'data', 'tenant-elsewhere')).ok, false, 'absolute path');
  assert.equal(badDir('../outside').ok, false, 'escaping path');
  assert.equal(badDir('.').ok, false, 'the repo root itself');

  for (const port of [80, 70000, 5173, 'abc', 5174.5]) {
    const r = T.validateRegistry({ tenants: [{ ...t0, port }] }, { root: REPO });
    assert.equal(r.ok, false, `port ${JSON.stringify(port)} must be rejected`);
  }

  assert.equal(T.validateRegistry({}, { root: REPO }).ok, false, 'no tenants array');
  assert.equal(T.validateRegistry({ tenants: [] }, { root: REPO }).ok, false, 'empty tenants');
  assert.equal(
    T.validateRegistry({ tenants: [{ ...t0, keyEnv: '' }] }, { root: REPO }).ok,
    false,
    'empty keyEnv'
  );
  assert.equal(
    T.validateRegistry({ tenants: [{ ...t0, name: 'bad name!' }] }, { root: REPO }).ok,
    false,
    'invalid name'
  );
});

test('resolveTenant accepts a name or a keyEnv and returns null when unknown', () => {
  const registry = load();
  assert.equal(T.resolveTenant(registry, 'acme').name, 'acme');
  assert.equal(T.resolveTenant(registry, 'ACME').name, 'acme');
  assert.equal(T.resolveTenant(registry, 'INGEST_KEY_FINTECH').name, 'fintech');
  assert.equal(T.resolveTenant(registry, 'ingest_key_acme').name, 'acme');
  assert.equal(T.resolveTenant(registry, 'nobody'), null);
  assert.throws(() => T.requireTenant(registry, 'nobody'), /unknown tenant/i);
});

// ------------------------------------------------------------------ child env

test('buildChildEnv gives each child its own PORT/WITNESS_DATA/INGEST_KEY/ORG and drops neighbour keys', () => {
  const registry = load();
  const [acme, fintech] = registry.tenants;
  const baseEnv = {
    PATH: process.env.PATH,
    INGEST_KEY: 'single-tenant-key',
    INGEST_KEY_ACME: 'key-acme',
    INGEST_KEY_FINTECH: 'key-fintech',
    SOMETHING: 'kept',
  };

  const a = T.buildChildEnv(acme, { root: REPO, baseEnv });
  const f = T.buildChildEnv(fintech, { root: REPO, baseEnv });

  assert.equal(a.PORT, '5174');
  assert.equal(f.PORT, '5175');
  assert.equal(a.WITNESS_DATA, path.join(REPO, 'data', 'tenants', 'acme'));
  assert.equal(f.WITNESS_DATA, path.join(REPO, 'data', 'tenants', 'fintech'));
  assert.notEqual(a.WITNESS_DATA, f.WITNESS_DATA);

  assert.equal(a.INGEST_KEY, 'key-acme');
  assert.equal(f.INGEST_KEY, 'key-fintech');
  assert.equal(a.ORG, 'ACME Pvt Ltd');
  assert.equal(f.ORG, 'Fintech Co');
  assert.equal(a.TENANT, 'acme');

  // lib/env.js would otherwise reload WITNESS_DATA / INGEST_KEY / ORG from .env
  assert.equal(a.WITNESS_TEST, '1');
  assert.equal(f.WITNESS_TEST, '1');

  // no neighbour's key travels with the child, and the single-tenant key never leaks in
  for (const env of [a, f]) {
    assert.deepEqual(Object.keys(env).filter((k) => /^INGEST_KEY_/i.test(k)), []);
    assert.notEqual(env.INGEST_KEY, 'single-tenant-key');
  }
  assert.equal(a.SOMETHING, 'kept');

  // explicit key always wins over the environment
  assert.equal(T.buildChildEnv(acme, { root: REPO, baseEnv, key: 'explicit' }).INGEST_KEY, 'explicit');
});

test('buildChildEnv refuses to start a tenant without an ingest key', () => {
  const acme = load().tenants[0];
  assert.throws(
    () => T.buildChildEnv(acme, { root: REPO, baseEnv: { PATH: process.env.PATH } }),
    /missing ingest key for tenant "acme".*INGEST_KEY_ACME/i
  );
  assert.throws(() => T.buildChildEnv(acme, { root: REPO, baseEnv: {}, key: '' }), /missing ingest key/i);
});

// ------------------------------------------------------------------ integration

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, route, { method = 'GET', body, key } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (key) headers['x-api-key'] = key;
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers, timeout: 3000, agent: false }, (res) => {
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, json: null, text: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(fn, { timeout = 25000, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function countLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

/** Where does a child's own module graph think the log lives? Same env, same answer. */
function probeStoreData(env) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./lib/store').DATA)"], {
    cwd: REPO,
    env,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `store probe failed: ${r.stderr}`);
  return r.stdout.trim();
}

test('two tenants on two ports cannot see each other\'s logs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `witness-tenants-${process.pid}-`));
  const ephemeral = new Set();
  const nextPort = async () => {
    for (;;) {
      const p = await freePort();
      if (!ephemeral.has(p)) {
        ephemeral.add(p);
        return p;
      }
    }
  };

  const registry = {
    tenants: [
      { name: 'alpha', port: await nextPort(), org: 'Alpha Co', dataDir: 'data/alpha', keyEnv: 'INGEST_KEY_ALPHA' },
      { name: 'beta', port: await nextPort(), org: 'Beta Co', dataDir: 'data/beta', keyEnv: 'INGEST_KEY_BETA' },
    ],
  };
  const [alpha, beta] = registry.tenants;

  const valid = T.validateRegistry(registry, { root });
  assert.equal(valid.ok, true, `temp registry invalid: ${valid.errors.join('; ')}`);

  const dirA = T.dataDirOf(alpha, root);
  const dirB = T.dataDirOf(beta, root);
  assert.notEqual(dirA, dirB);

  const keyA = 'tf_test_alpha_key';
  const keyB = 'tf_test_beta_key';
  const envA = T.buildChildEnv(alpha, { root, key: keyA });
  const envB = T.buildChildEnv(beta, { root, key: keyB });
  // Tests must never dial a chain: roots stay in each tenant's own ledger.
  for (const env of [envA, envB]) {
    env.ANCHOR_ON_CHAIN = 'false';
    env.BATCH_SIZE = '100';
    env.WITNESS_TEST = '1';
  }

  const children = [];
  t.after(async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(resolve, 4000);
            timer.unref();
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            child.kill('SIGKILL');
          })
      )
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  const start = (tenant, env) => {
    const child = spawn(process.execPath, [path.join(REPO, 'server.js')], {
      cwd: REPO,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.getOutput = () => output;
    children.push(child);
    return child;
  };

  const childA = start(alpha, envA);
  const childB = start(beta, envB);

  const stats = (port) => request(port, '/api/stats').then((r) => (r.status === 200 ? r.json : null));
  const statsA = await waitFor(() => stats(alpha.port), { label: `alpha /api/stats (${childA.getOutput()})` });
  const statsB = await waitFor(() => stats(beta.port), { label: `beta /api/stats (${childB.getOutput()})` });

  assert.equal(statsA.entries, 0, 'tenant A starts empty');
  assert.equal(statsB.entries, 0, 'tenant B starts empty');
  assert.equal(statsA.ingest.enabled, true);
  assert.equal(statsB.ingest.enabled, true);

  // ---- where each child actually writes ----
  const dataA = probeStoreData(envA);
  const dataB = probeStoreData(envB);
  assert.equal(path.resolve(dataA), path.resolve(dirA), 'tenant A must write to its own dir');
  assert.equal(path.resolve(dataB), path.resolve(dirB), 'tenant B must write to its own dir');
  assert.notEqual(path.resolve(dataA), path.resolve(dataB));

  // ---- one entry into each, with its own key ----
  const wroteA = await request(alpha.port, '/api/log', {
    method: 'POST',
    key: keyA,
    body: { actor: 'alice', action: 'tenant-alpha-only-marker', meta: { tenant: 'alpha' } },
  });
  assert.equal(wroteA.status, 202, `alpha ingest failed: ${wroteA.text}`);
  assert.equal(wroteA.json.accepted, 1);
  assert.equal(wroteA.json.receipts.length, 1);

  const wroteB = await request(beta.port, '/api/log', {
    method: 'POST',
    key: keyB,
    body: { actor: 'bob', action: 'tenant-beta-only-marker', meta: { tenant: 'beta' } },
  });
  assert.equal(wroteB.status, 202, `beta ingest failed: ${wroteB.text}`);
  assert.equal(wroteB.json.accepted, 1);

  // ---- counts are independent: 1 and 1, not 2 ----
  assert.equal((await stats(alpha.port)).entries, 1);
  assert.equal((await stats(beta.port)).entries, 1);

  // ---- neither tenant can read the other's entry ----
  const searchA = await request(alpha.port, '/api/entries?q=tenant-beta-only-marker');
  const searchB = await request(beta.port, '/api/entries?q=tenant-alpha-only-marker');
  assert.equal(searchA.status, 200);
  assert.equal(searchB.status, 200);
  assert.equal(searchA.json.total, 0, `alpha must not see beta's entry: ${searchA.text}`);
  assert.equal(searchB.json.total, 0, `beta must not see alpha's entry: ${searchB.text}`);

  const ownA = await request(alpha.port, '/api/entries?q=tenant-alpha-only-marker');
  const ownB = await request(beta.port, '/api/entries?q=tenant-beta-only-marker');
  assert.equal(ownA.json.total, 1);
  assert.equal(ownA.json.entries[0].actor, 'alice');
  assert.equal(ownB.json.total, 1);
  assert.equal(ownB.json.entries[0].actor, 'bob');

  // ---- keys do not cross tenants ----
  const crossA = await request(beta.port, '/api/log', {
    method: 'POST',
    key: keyA,
    body: { actor: 'alice', action: 'cross-tenant-write-attempt' },
  });
  assert.equal(crossA.status, 401, 'alpha key must be rejected by beta');
  assert.equal((await stats(beta.port)).entries, 1, 'rejected write must not land');

  const wrongKey = await request(alpha.port, '/api/log', {
    method: 'POST',
    key: 'not-a-tenant-key',
    body: { actor: 'mallory', action: 'forged' },
  });
  assert.equal(wrongKey.status, 401);
  assert.equal((await stats(alpha.port)).entries, 1);

  // ---- files on disk are separate and hold only their own marker ----
  const logsA = fs.readFileSync(path.join(dirA, 'logs.jsonl'), 'utf8');
  const logsB = fs.readFileSync(path.join(dirB, 'logs.jsonl'), 'utf8');
  assert.match(logsA, /tenant-alpha-only-marker/);
  assert.doesNotMatch(logsA, /tenant-beta-only-marker/);
  assert.match(logsB, /tenant-beta-only-marker/);
  assert.doesNotMatch(logsB, /tenant-alpha-only-marker/);

  assert.equal(countLines(path.join(dirA, 'logs.jsonl')), 1);
  assert.equal(countLines(path.join(dirB, 'logs.jsonl')), 1);
  assert.equal(countLines(path.join(dirA, 'auditor', 'receipts.jsonl')), 1);
  assert.equal(countLines(path.join(dirB, 'auditor', 'receipts.jsonl')), 1);

  // sequence namespaces restart per tenant, which is the point of separate processes
  assert.equal(JSON.parse(logsA.trim()).seq, 1);
  assert.equal(JSON.parse(logsB.trim()).seq, 1);
  assert.notEqual(JSON.parse(logsA.trim()).hash, JSON.parse(logsB.trim()).hash);

  // ---- nothing landed in the repo's single-tenant data dir ----
  const repoData = path.join(REPO, 'data');
  assert.ok(!path.resolve(dataA).startsWith(path.resolve(repoData) + path.sep));
  assert.ok(!path.resolve(dataB).startsWith(path.resolve(repoData) + path.sep));
});
