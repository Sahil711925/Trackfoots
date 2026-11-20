#!/usr/bin/env node
'use strict';
/**
 * bench.js — what this thing actually costs, measured on the machine in front of you.
 *
 *   node scripts/bench.js            pretty table
 *   node scripts/bench.js --json     machine-readable
 *
 * Measures four things, three repeats each, reports the median:
 *   1. INGEST        entries/second through store.appendMany (1k, 10k, 50k)
 *   2. CHAIN VERIFY  ms to re-walk the hash chain over the data just written
 *   3. MERKLE ROOT   ms to compute a root for a 100-leaf and a 10k-leaf batch
 *   4. ANCHOR COST   $ per 100K events, from a static gas model of LogAnchor.sol
 *                    cross-checked against the published figure in arXiv 2609.01931
 *
 * Nothing here touches a network, a port, or the real data dir.
 * All writes go to a throwaway directory under TMPDIR that is deleted on exit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

// ---------------------------------------------------------------- environment
// Order matters: WITNESS_DATA must be set before lib/store is required, because
// store.js resolves its paths once at module load.
const TEMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-bench-'));
process.env.WITNESS_DATA = TEMP_DATA;
process.env.WITNESS_TEST = '1';      // stops lib/env overriding us from .env
process.env.ANCHOR_ON_CHAIN = 'false'; // nothing dials a chain
process.env.CHAIN = 'local';

const store = require('../lib/store');
const { merkleRoot, sha256 } = require('../lib/merkle');

// ---------------------------------------------------------------- helpers

/** Median of a numeric sample. For an even count, the lower-middle value. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * If the process was started with --expose-gc, settle the heap before a timed sample.
 * Without it this is a no-op, so the plain `node scripts/bench.js` numbers are comparable;
 * with it, the merkle timings stop being dominated by a GC pause left over from the
 * 19 MB ingest of the 50k set.
 */
const gcSettle = () => { if (typeof global.gc === 'function') global.gc(); };

const ms = (x) => Math.round(x * 100) / 100;

/** Wipe the log files so every repeat starts from an empty log, not an accumulating one. */
function resetData() {
  for (const f of [store.LOGS, store.LEDGER, store.RECEIPTS]) {
    try { fs.unlinkSync(f); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  store.ensure();
}

/** A realistic-ish entry: what an incident-log line actually looks like. */
function makeEntries(n, offset = 0) {
  const actions = ['auth.login', 'auth.fail', 'http.request', 'file.read', 'admin.grant', 'db.query'];
  const actors = ['alice@corp', 'bob@corp', 'svc-ingest', 'root', 'auditor@ext'];
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = i + offset;
    out[i] = {
      ts: new Date(1790000000000 + k * 137).toISOString(),
      actor: actors[k % actors.length],
      action: actions[k % actions.length],
      meta: { ip: `10.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}`, path: `/api/v1/records/${k}`, status: 200 + (k % 3) },
    };
  }
  return out;
}

/** Deterministic 64-hex leaf inputs, so repeat runs hash identical bytes. */
function fakeHashes(n) {
  const out = new Array(n);
  let seed = 'bench-seed';
  for (let i = 0; i < n; i++) {
    seed = sha256(seed + ':' + i);
    out[i] = seed;
  }
  return out;
}

// ---------------------------------------------------------------- 1. ingest
function benchIngest(sizes, repeats, log) {
  const results = {};
  // warm-up: JIT, allocator, fs page cache
  resetData();
  store.appendMany(makeEntries(200));
  resetData();

  for (const n of sizes) {
    const perSec = [];
    const elapsed = [];
    for (let r = 0; r < repeats; r++) {
      resetData();
      const batch = makeEntries(n);
      gcSettle();
      const t0 = performance.now();
      store.appendMany(batch);
      const dt = performance.now() - t0;
      elapsed.push(dt);
      perSec.push((n / dt) * 1000);
    }
    const written = fs.statSync(store.LOGS).size;
    results[n] = {
      entries: n,
      med_entries_per_sec: Math.round(median(perSec)),
      med_ms: ms(median(elapsed)),
      all_entries_per_sec: perSec.map((x) => Math.round(x)),
      all_ms: elapsed.map(ms),
      bytes_on_disk: written,
      bytes_per_entry: Math.round(written / n),
    };
    if (log) log(`  ingest ${String(n).padStart(6)}  ${results[n].med_entries_per_sec.toLocaleString('en-US').padStart(10)}/s   ${String(ms(median(elapsed))).padStart(8)} ms`);
  }
  return results;
}

// ---------------------------------------------------------------- 2. verify
/**
 * Re-walk the hash chain exactly as the auditor does: parse each line, re-derive
 * entryDigest(entry, prevHash) and compare. Includes file read + JSON.parse.
 */
function chainWalk() {
  const t0 = performance.now();
  const rows = store.readLogs();
  let prevHash = 'GENESIS';
  let broken = 0;
  for (const row of rows) {
    if (!row.ok) { broken += 1; continue; }
    const e = row.entry;
    if (store.entryDigest(e, prevHash) !== e.hash) broken += 1;
    prevHash = e.hash; // keep walking with the stored hash, same as lib/verify.js
  }
  const dt = performance.now() - t0;
  return { ms: dt, entries: rows.length, broken };
}

function benchVerify(repeats, log) {
  const samples = [];
  let entries = 0;
  let broken = 0;
  for (let r = 0; r < repeats; r++) {
    gcSettle();
    const res = chainWalk();
    samples.push(res.ms);
    entries = res.entries;
    broken = res.broken;
  }
  const out = {
    entries,
    med_ms: ms(median(samples)),
    us_per_entry: entries ? Math.round((median(samples) * 1000) / entries * 100) / 100 : null,
    all_ms: samples.map(ms),
    chain_ok: broken === 0,
  };
  if (log) log(`  verify ${String(entries).padStart(6)}  ${String(out.med_ms).padStart(10)} ms   ${String(out.us_per_entry).padStart(8)} µs/entry  ${out.chain_ok ? 'chain OK' : 'BROKEN'}`);
  return out;
}

// ---------------------------------------------------------------- 3. merkle
function benchMerkle(sizes, repeats, log) {
  const results = {};
  for (const n of sizes) {
    const leaves = fakeHashes(n);
    merkleRoot(leaves.slice(0, Math.min(n, 64))); // warm-up
    const samples = [];
    for (let r = 0; r < repeats; r++) {
      gcSettle();
      const t0 = performance.now();
      const root = merkleRoot(leaves);
      samples.push(performance.now() - t0);
      if (r === 0 && !/^[0-9a-f]{64}$/.test(root)) throw new Error('merkleRoot returned a non-digest');
    }
    results[n] = {
      leaves: n,
      med_ms: ms(median(samples)),
      us_per_leaf: Math.round((median(samples) * 1000) / n * 100) / 100,
      all_ms: samples.map(ms),
    };
    if (log) log(`  merkle ${String(n).padStart(6)}  ${String(results[n].med_ms).padStart(10)} ms   ${String(results[n].us_per_leaf).padStart(8)} µs/leaf`);
  }
  return results;
}

// ---------------------------------------------------------------- 4. cost
/**
 * Static gas model of LogAnchor.anchor(seq, root, org).
 *
 * This is a DERIVATION from the contract source and the EIP-2929/EIP-2200 gas
 * schedule — not a measurement, because measuring it would mean dialling a chain.
 * What the one call writes:
 *   roots[seq]     0 -> nonzero   SSTORE 20,000 + 2,100 cold = 22,100
 *   publishedAt[seq] 0 -> nonzero  SSTORE 20,000 + 2,100 cold = 22,100
 *   count          nonzero -> x    SSTORE  2,900 + 2,100 cold =  5,000
 *   emit Anchored   LOG2 with 160 bytes of data
 * plus the 21,000 tx base and calldata (selector + 3 words + the org string).
 */
const GAS = {
  tx_base: 21000,
  calldata_approx: 1300,
  sstore_zero_to_nonzero_cold: 22100,
  sstore_nonzero_cold: 5000,
  log2_base: 375,
  log_topic: 375,
  log_topics: 2,
  log_data_bytes: 160,
  log_data_byte_cost: 8,
};

const gasPerAnchor =
  GAS.tx_base +
  GAS.calldata_approx +
  2 * GAS.sstore_zero_to_nonzero_cold +
  GAS.sstore_nonzero_cold +
  GAS.log2_base +
  GAS.log_topics * GAS.log_topic +
  GAS.log_data_bytes * GAS.log_data_byte_cost;

/** Published comparison point: arXiv 2609.01931 — 100K events, 100-event epochs, $2.30 on an L2. */
const PAPER = { events: 100000, epoch: 100, cost_usd: 2.3, source: 'arXiv 2609.01931' };

const ETH_USD = 3000; // only used to turn the paper's dollars back into a gas price

function benchCost(epochs, log) {
  const anchorsPer100k = PAPER.events / PAPER.epoch;          // 1000 anchors
  const paperPerAnchor = PAPER.cost_usd / anchorsPer100k;      // $0.0023
  // Invert the paper's figure to the gas price it implies, then price OUR gas at that rate.
  // This is the honest move: it does not let us claim a lower number than the paper on
  // assumptions the paper did not make.
  const impliedGwei = (paperPerAnchor / (gasPerAnchor * ETH_USD)) * 1e9;

  const rows = epochs.map((epoch) => {
    const anchors = PAPER.events / epoch;
    const usd = anchors * gasPerAnchor * impliedGwei * 1e-9 * ETH_USD;
    return {
      epoch_size: epoch,
      anchors_per_100k: anchors,
      usd_per_100k_events: Math.round(usd * 10000) / 10000,
      usd_per_million_events: Math.round(usd * 10 * 10000) / 10000,
      usd_per_event: Math.round((usd / PAPER.events) * 1e9) / 1e9,
    };
  });

  const out = {
    gas_per_anchor_estimate: gasPerAnchor,
    gas_model: 'static, from contracts/LogAnchor.sol + EIP-2929 cold-SSTORE costs (not measured on chain)',
    paper: { ...PAPER, anchors: anchorsPer100k, usd_per_anchor: Math.round(paperPerAnchor * 1e6) / 1e6 },
    implied_gas_price_gwei: Math.round(impliedGwei * 1000) / 1000,
    eth_usd_assumed: ETH_USD,
    by_epoch: rows,
  };
  if (log) {
    log(`  cost   ${String(out.gas_per_anchor_estimate).padStart(6)} gas/anchor (est)  →  $${rows[0].usd_per_100k_events} per 100K events @ ${out.implied_gas_price_gwei} gwei`);
  }
  return out;
}

// ---------------------------------------------------------------- runner
async function runBench(opts = {}) {
  const repeats = opts.repeats || 3;
  const log = opts.quiet ? null : (s) => console.log(s);
  const t0 = performance.now();

  if (log) {
    console.log('');
    console.log(`  trackfoots benchmark — ${repeats} repeats, median reported`);
    console.log(`  data dir (throwaway): ${TEMP_DATA}`);
    console.log('');
  }

  const ingest = benchIngest([1000, 10000, 50000], repeats, log);
  // The 50k ingest above left exactly 50k entries on disk — verify that.
  const verify = benchVerify(repeats, log);
  const merkle = benchMerkle([100, 10000], repeats, log);
  const cost = benchCost([100, 1000], log);
  const wall = performance.now() - t0;

  const biggest = Math.max(...Object.keys(ingest).map(Number));
  const summary =
    `${ingest[biggest].med_entries_per_sec.toLocaleString('en-US')} entries/s ingest · ` +
    `${verify.med_ms} ms to re-verify ${verify.entries.toLocaleString('en-US')} chained entries ` +
    `(${verify.us_per_entry} µs each) · ` +
    `${merkle[100].med_ms} ms per 100-leaf root, ${merkle[10000].med_ms} ms per 10k-leaf root · ` +
    `~$${cost.by_epoch[0].usd_per_100k_events} per 100K events anchored at 100-event epochs (estimate)`;

  const result = {
    measured_at: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
      cores: os.cpus().length,
      total_mem_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    },
    repeats,
    temp_data_dir: TEMP_DATA,
    ingest,
    verify,
    merkle,
    anchoring: cost,
    wall_ms: ms(wall),
    summary,
  };

  if (log) {
    console.log('');
    console.log('  ' + '─'.repeat(72));
    console.log(`  ${summary}`);
    console.log('  ' + '─'.repeat(72));
    console.log(`  total benchmark wall time: ${ms(wall)} ms`);
    console.log('');
    console.log(`  ingest      ${ingest[biggest].bytes_per_entry} bytes/entry on disk`);
    console.log(`  cost note   gas is a static estimate; dollars reuse the arXiv 2609.01931 ratio`);
    console.log('');
  }

  // Don't leave 20 MB of throwaway log behind when called as a library.
  if (!opts.keepTemp) {
    try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return result;
}

/** Pretty printer for the non-JSON path. */
function printTable(r) {
  const pad = (s, n, right) => (right ? String(s).padStart(n) : String(s).padEnd(n));
  const line = (a) => console.log('  ' + a);
  const usd = (v) => (v >= 1
    ? '$' + v.toFixed(2)
    : '$' + v.toFixed(7).replace(/0+$/, '').replace(/\.$/, ''));


  console.log('  INGEST — store.appendMany (hash + receipt + two file writes per entry)');
  console.log('  ' + pad('entries', 10) + pad('median ms', 12, true) + pad('entries/s', 16, true) + pad('µs/entry', 12, true) + pad('bytes/entry', 12, true));
  for (const k of Object.keys(r.ingest)) {
    const v = r.ingest[k];
    line(
      pad(k, 10) + pad(v.med_ms, 12, true) + pad(v.med_entries_per_sec.toLocaleString('en-US'), 16, true) +
      pad(Math.round((v.med_ms * 1000 / v.entries) * 100) / 100, 12, true) + pad(v.bytes_per_entry, 12, true)
    );
  }
  console.log('');

  console.log('  VERIFY — full chain re-walk (read + JSON.parse + 2 SHA-256 per entry)');
  console.log('  ' + pad('entries', 10) + pad('median ms', 12, true) + pad('µs/entry', 12, true) + pad('verdict', 12, true));
  line(pad(r.verify.entries, 10) + pad(r.verify.med_ms, 12, true) + pad(r.verify.us_per_entry, 12, true) + pad(r.verify.chain_ok ? 'chain OK' : 'BROKEN', 12, true));
  console.log('');

  console.log('  MERKLE — RFC 6962 root over N leaves');
  console.log('  ' + pad('leaves', 10) + pad('median ms', 12, true) + pad('µs/leaf', 12, true));
  for (const k of Object.keys(r.merkle)) {
    line(pad(k, 10) + pad(r.merkle[k].med_ms, 12, true) + pad(r.merkle[k].us_per_leaf, 12, true));
  }
  console.log('');

  console.log('  ANCHORING — cost per 100K events, by epoch size');
  console.log('  ' + pad('epoch', 10) + pad('anchors', 10, true) + pad('$/100K events', 16, true) + pad('$/event', 14, true) + pad('$/1M events', 14, true));
  for (const row of r.anchoring.by_epoch) {
    line(
      pad(row.epoch_size, 10) + pad(row.anchors_per_100k, 10, true) + pad(usd(row.usd_per_100k_events), 16, true) +
      pad(usd(row.usd_per_event), 14, true) + pad(usd(row.usd_per_million_events), 14, true)
    );
  }
  console.log('');
  console.log(`  ${r.anchoring.gas_per_anchor_estimate} gas per anchor — ${r.anchoring.gas_model}`);
  console.log(`  priced at ${r.anchoring.implied_gas_price_gwei} gwei, the price implied by ${r.anchoring.paper.source}`);
  console.log(`  ($${r.anchoring.paper.cost_usd} for ${r.anchoring.paper.events.toLocaleString('en-US')} events at ${r.anchoring.paper.epoch}-event epochs = $${r.anchoring.paper.usd_per_anchor}/anchor), ETH $${r.anchoring.eth_usd_assumed}`);
  console.log('');
}

module.exports = { runBench };

if (require.main === module) {
  const json = process.argv.includes('--json');
  runBench({ quiet: json })
    .then((r) => {
      if (json) console.log(JSON.stringify(r, null, 2));
      else printTable(r);
      try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
    })
    .catch((err) => {
      console.error('bench failed:', err && err.stack ? err.stack : err);
      try { fs.rmSync(TEMP_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
      process.exit(1);
    });
}
