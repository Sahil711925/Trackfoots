'use strict';
/**
 * tenants.js (lib) — the registry that makes one deployment serve several companies.
 *
 * The architecture is **isolation by process**: each tenant is a separate `node server.js`
 * child with its own PORT, WITNESS_DATA, INGEST_KEY and ORG. Nothing is shared — not the log
 * file, not the ledger, not the auditor receipts, not the chain sequence namespace. That is
 * the honest version of multi-tenancy for this codebase: one missed `WHERE tenant = ?` in a
 * row-level design leaks a customer's root, while a separate data directory cannot leak what
 * it never opens.
 *
 * This module is deliberately pure: it reads a JSON file (loadRegistry) and computes values.
 * It never spawns, never writes, and does nothing at require time.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_DATA_DIR = path.join(ROOT, 'data');
const REGISTRY_FILE = path.join(ROOT, 'tenants.json');

/** The single-tenant server owns 5173. A tenant squatting on it would shadow the demo. */
const RESERVED_PORTS = new Set([5173]);
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const KEY_ENV_RE = /^[A-Z][A-Z0-9_]*$/;

function registryPath(root = ROOT) {
  return path.join(root, 'tenants.json');
}

/**
 * Read the registry from disk. Shape errors are validation errors, not crashes, so the caller
 * gets the same { ok, errors } contract as validateRegistry().
 */
function loadRegistry(file = REGISTRY_FILE) {
  const text = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  return parsed;
}

function normaliseDir(p) {
  const resolved = path.resolve(p);
  // Windows treats C:\Data and c:\data as the same directory; Linux does not.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Validate a registry object against the invariants the launcher depends on.
 *
 * Pure: no fs access, no throwing for bad input. Returns every problem at once so a bad
 * registry is fixed in one edit instead of one error per run.
 *
 * @param {object} registry
 * @param {{ root?: string, baseDataDir?: string }} [opts]
 * @returns {{ ok: boolean, errors: string[], tenants: object[] }}
 */
function validateRegistry(registry, opts = {}) {
  const root = opts.root || ROOT;
  const baseDataDir = opts.baseDataDir || path.join(root, 'data');
  const errors = [];

  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    return { ok: false, errors: ['registry must be an object with a "tenants" array'], tenants: [] };
  }
  if (!Array.isArray(registry.tenants)) {
    return { ok: false, errors: ['registry.tenants must be an array'], tenants: [] };
  }
  if (registry.tenants.length === 0) {
    return { ok: false, errors: ['registry.tenants must contain at least one tenant'], tenants: [] };
  }

  const seenNames = new Map();
  const seenPorts = new Map();
  const seenDirs = new Map();
  const seenKeys = new Map();
  const baseNorm = normaliseDir(baseDataDir);

  registry.tenants.forEach((t, i) => {
    const where = `tenants[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      errors.push(`${where} must be an object`);
      return;
    }

    // ---- name ----
    const name = t.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      errors.push(`${where}.name must match ${NAME_RE} (got ${JSON.stringify(name)})`);
    } else {
      const k = name.toLowerCase();
      if (seenNames.has(k)) errors.push(`duplicate tenant name "${name}" (${seenNames.get(k)} and ${where})`);
      else seenNames.set(k, where);
    }

    // ---- port ----
    const port = t.port;
    if (!Number.isInteger(port)) {
      errors.push(`${where}.port must be an integer (got ${JSON.stringify(port)})`);
    } else if (port < MIN_PORT || port > MAX_PORT) {
      errors.push(`${where}.port ${port} is out of range ${MIN_PORT}-${MAX_PORT}`);
    } else if (RESERVED_PORTS.has(port)) {
      errors.push(`${where}.port ${port} is reserved for the single-tenant server`);
    } else if (seenPorts.has(port)) {
      errors.push(`duplicate port ${port} (${seenPorts.get(port)} and ${where})`);
    } else {
      seenPorts.set(port, where);
    }

    // ---- dataDir ----
    const dataDir = t.dataDir;
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
      errors.push(`${where}.dataDir must be a non-empty string`);
    } else if (path.isAbsolute(dataDir)) {
      errors.push(`${where}.dataDir must be relative to the repo root, not absolute (${dataDir})`);
    } else {
      const resolvedNorm = normaliseDir(path.resolve(root, dataDir));
      const fromRoot = path.relative(normaliseDir(root), resolvedNorm);
      if (resolvedNorm === baseNorm) {
        errors.push(`${where}.dataDir points at the base data dir (${dataDir}) — every tenant would share one log`);
      } else if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
        errors.push(`${where}.dataDir must be a directory inside the repo (got ${dataDir})`);
      } else if (seenDirs.has(resolvedNorm)) {
        errors.push(`duplicate dataDir "${dataDir}" (${seenDirs.get(resolvedNorm)} and ${where})`);
      } else {
        seenDirs.set(resolvedNorm, where);
      }
    }

    // ---- keyEnv ----
    const keyEnv = t.keyEnv;
    if (typeof keyEnv !== 'string' || !KEY_ENV_RE.test(keyEnv)) {
      errors.push(`${where}.keyEnv must be an ENV_VAR name matching ${KEY_ENV_RE} (got ${JSON.stringify(keyEnv)})`);
    } else {
      const k = keyEnv.toUpperCase();
      if (seenKeys.has(k)) errors.push(`duplicate keyEnv ${keyEnv} (${seenKeys.get(k)} and ${where}) — tenants would share an ingest key`);
      else seenKeys.set(k, where);
    }

    // ---- org (optional, defaults to name) ----
    if (t.org !== undefined && (typeof t.org !== 'string' || t.org.trim() === '')) {
      errors.push(`${where}.org must be a non-empty string when present`);
    }
  });

  return { ok: errors.length === 0, errors, tenants: Array.isArray(registry.tenants) ? registry.tenants : [] };
}

/** Same checks, but throws a single readable error. Used by the CLI. */
function assertValidRegistry(registry, opts = {}) {
  const result = validateRegistry(registry, opts);
  if (!result.ok) {
    const err = new Error(`invalid tenant registry:\n  - ${result.errors.join('\n  - ')}`);
    err.errors = result.errors;
    throw err;
  }
  return registry;
}

/** Absolute on-disk data directory for a tenant. */
function dataDirOf(tenant, root = ROOT) {
  return path.resolve(root, tenant.dataDir);
}

function urlOf(tenant, host = '127.0.0.1') {
  return `http://${host}:${tenant.port}`;
}

/**
 * Find a tenant by `name` (case-insensitive) or by its `keyEnv` (e.g. INGEST_KEY_ACME), which is
 * what an operator usually has in hand while wiring up an emitter.
 * @returns {object|null}
 */
function resolveTenant(registry, selector) {
  if (!registry || !Array.isArray(registry.tenants) || typeof selector !== 'string') return null;
  const want = selector.trim().toLowerCase();
  return (
    registry.tenants.find((t) => t && typeof t.name === 'string' && t.name.toLowerCase() === want) ||
    registry.tenants.find((t) => t && typeof t.keyEnv === 'string' && t.keyEnv.toLowerCase() === want) ||
    null
  );
}

function requireTenant(registry, selector) {
  const t = resolveTenant(registry, selector);
  if (!t) {
    const known = (registry && registry.tenants ? registry.tenants : []).map((x) => x.name).join(', ');
    throw new Error(`unknown tenant "${selector}" — registry has: ${known || '(none)'}`);
  }
  return t;
}

/**
 * Build the environment for one tenant's child process.
 *
 * The important part is `WITNESS_TEST=1`. lib/env.js treats WITNESS_DATA / INGEST_KEY / ORG as
 * FORCE_FROM_FILE, so a value inherited from the shell is normally **overwritten by .env** at
 * require time. For a launcher that is catastrophic: every child would land on the same data
 * directory and the same ingest key while still looking healthy. WITNESS_TEST=1 is the
 * documented escape hatch that makes explicit env vars win over the file. See docs/TENANTS.md.
 *
 * The other tenant keys (INGEST_KEY_*) are stripped so a child can never read its neighbour's.
 *
 * @param {object} tenant
 * @param {{ root?: string, baseEnv?: object, key?: string }} [opts]
 * @returns {object} env for child_process.spawn
 */
function buildChildEnv(tenant, opts = {}) {
  const root = opts.root || ROOT;
  const baseEnv = opts.baseEnv || process.env;
  const key = opts.key !== undefined ? opts.key : baseEnv[tenant.keyEnv];

  if (typeof key !== 'string' || key === '') {
    throw new Error(`missing ingest key for tenant "${tenant.name}": export ${tenant.keyEnv}`);
  }

  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (/^INGEST_KEY/i.test(k)) continue; // no neighbour's key, not even the single-tenant one
    env[k] = v;
  }

  env.PORT = String(tenant.port);
  env.WITNESS_DATA = dataDirOf(tenant, root);
  env.INGEST_KEY = key;
  env.ORG = tenant.org || tenant.name;
  env.TENANT = tenant.name;
  // env-vars-win mode; without it lib/env.js reloads WITNESS_DATA/INGEST_KEY/ORG from .env
  env.WITNESS_TEST = '1';
  return env;
}

/** The row the CLI prints. Kept here so scripts and docs agree on the shape. */
function describe(tenant, root = ROOT) {
  return {
    name: tenant.name,
    port: tenant.port,
    org: tenant.org || tenant.name,
    keyEnv: tenant.keyEnv,
    dataDir: dataDirOf(tenant, root),
    url: urlOf(tenant),
  };
}

module.exports = {
  ROOT,
  BASE_DATA_DIR,
  REGISTRY_FILE,
  RESERVED_PORTS,
  MIN_PORT,
  MAX_PORT,
  registryPath,
  loadRegistry,
  validateRegistry,
  assertValidRegistry,
  dataDirOf,
  urlOf,
  resolveTenant,
  requireTenant,
  buildChildEnv,
  describe,
};
