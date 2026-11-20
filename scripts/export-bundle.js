#!/usr/bin/env node
'use strict';
/**
 * export-bundle.js — produce the court/auditor exhibit for one entry.
 *
 *   node scripts/export-bundle.js <seq>
 *
 * Writes exports/bundle-<seq>.html and prints its path on stdout.
 * Exits non-zero if the entry (or the batch that covers it) does not exist,
 * so a scripted evidence request can never silently produce an empty exhibit.
 */
process.env.ANCHOR_ON_CHAIN = process.env.ANCHOR_ON_CHAIN || 'false';

require('../lib/env');

const fs = require('fs');
const path = require('path');

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('usage: node scripts/export-bundle.js <seq>');
  console.error('  example: node scripts/export-bundle.js 137');
  process.exit(2);
}

const raw = process.argv[2];
// Accept only a plain positive integer, so "137abc" or "-1" never reaches the log walker.
if (raw === undefined || !/^\d+$/.test(String(raw).trim())) usage(raw ? `not a sequence number: ${raw}` : 'missing <seq>');
const seq = Number(String(raw).trim());
if (!Number.isInteger(seq) || seq <= 0) usage(`not a sequence number: ${raw}`);

const { buildBundle } = require('../lib/bundle');

buildBundle(seq)
  .then(({ path: outPath }) => {
    const bytes = fs.statSync(outPath).size;
    console.log(outPath);
    console.error(`wrote ${bytes} bytes · entry #${seq} · ${path.basename(outPath)}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`export failed: ${err.message}`);
    process.exit(err.code === 'EBADSEQ' ? 2 : 1);
  });
