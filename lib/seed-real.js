'use strict';
/**
 * seed-real.js (lib) — fill the store with authentic-format log lines.
 *
 * Reads samples/, parses with the real parsers, and cycles the parsed lines until the requested
 * count is reached, re-timing them so the stream looks like it arrived over the last hours.
 * Falls back to the synthetic seeder when the samples are missing, so a demo can never fail here.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { parseLine, detectFormat } = require('./formats');
const { seed } = require('./seed');

const SAMPLES = path.join(__dirname, '..', 'samples');
const FILES = ['auth.log', 'access.log', 'syslog.log'];

function loadParsed(log = () => {}) {
  const out = [];
  for (const name of FILES) {
    const file = path.join(SAMPLES, name);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const format = detectFormat(lines);
    let parsed = 0;
    for (const line of lines) {
      const r = parseLine(line);
      if (!r) continue;
      parsed += 1;
      out.push({ source: name, format, actor: r.actor, action: r.action, meta: r.meta || {} });
    }
    log(`  ${name.padEnd(12)} ${String(lines.length).padStart(3)} lines · format ${format} · ${parsed} parsed`);
  }
  return out;
}

function seedReal(count = 1200, { log = () => {} } = {}) {
  store.ensure();
  const pool = loadParsed(log);
  if (!pool.length) {
    log('  no samples found — falling back to synthetic entries');
    return seed(count);
  }

  const start = Date.now() - count * 40 * 1000;
  const batch = [];
  for (let i = 0; i < count; i++) {
    const src = pool[i % pool.length];
    batch.push({
      ts: new Date(start + i * 40 * 1000).toISOString(),
      actor: src.actor,
      action: src.action,
      meta: { ...src.meta, source: src.source, format: src.format },
    });
  }
  store.appendMany(batch);
  log(`  seeded ${batch.length} entries from ${pool.length} real parsed lines`);
  return batch.length;
}

module.exports = { seedReal, loadParsed };
