#!/usr/bin/env node
'use strict';
/**
 * seed-real.js — fill the demo with authentic-format log lines instead of invented ones.
 *
 * The synthetic seeder exists so numbers are reproducible, but "login success / cat /etc/passwd"
 * looks like a fixture. This reads the sample files, parses them with the real parsers, and
 * cycles them until the requested count is reached, re-timing the entries so the stream looks
 * like it arrived over the last few hours.
 *
 *   node scripts/seed-real.js [count]      default 1200
 */
require('../lib/env');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const { parseLine, detectFormat } = require('../lib/formats');

const SAMPLES = path.join(__dirname, '..', 'samples');
const FILES = ['auth.log', 'access.log', 'syslog.log'];

function loadParsed() {
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
    process.stderr.write(`  ${name.padEnd(12)} ${String(lines.length).padStart(3)} lines · format ${format} · ${parsed} parsed\n`);
  }
  if (!out.length) throw new Error('no sample lines parsed — is samples/ present?');
  return out;
}

const count = Number(process.argv[2] || 1200);
const pool = loadParsed();
store.ensure();

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
console.log(`seeded ${batch.length} entries from ${pool.length} real parsed lines (${FILES.length} source files)`);
