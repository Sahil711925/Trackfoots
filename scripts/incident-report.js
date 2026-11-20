#!/usr/bin/env node
'use strict';
/**
 * incident-report.js — write the CERT-In 6-hour notification for the current log state.
 *
 *   node scripts/incident-report.js            → exports/incident-<id>.html + .json
 *   node scripts/incident-report.js --json     → summary on stdout only
 *
 * Run it after an attack to produce the artifact; run it on a clean log to prove it reports
 * "no integrity failure" rather than inventing an incident.
 */
require('../lib/env');
const fs = require('fs');
const path = require('path');
const { verify } = require('../lib/verify');
const store = require('../lib/store');
const { build } = require('../lib/incident-report');

const OUT = path.join(__dirname, '..', 'exports');

function deployment() {
  const file = path.join(__dirname, '..', 'deployments.json');
  if (!fs.existsSync(file)) return null;
  try {
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = process.env.CHAIN || 'local';
    return all[key] || Object.values(all)[0] || null;
  } catch {
    return null;
  }
}

const report = verify();
const ledger = store.readLedger();
const dep = deployment();
const chain = { address: dep && dep.address, network: process.env.CHAIN || 'local' };
const { summary, html } = build(report, chain, ledger, process.env.ORG || 'Trackfoots');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
const base = path.join(OUT, `incident-${summary.incidentId}`);
fs.writeFileSync(`${base}.html`, html);
fs.writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));

console.log(`incident  ${summary.incidentId}`);
console.log(`verdict   ${summary.verdict}`);
console.log(`missing   ${summary.entriesMissing} · rewritten ${summary.entriesRewritten} · affected batches ${summary.affectedBatches.length}`);
console.log(`written   ${path.relative(process.cwd(), base)}.html`);
console.log(`          ${path.relative(process.cwd(), base)}.json`);
