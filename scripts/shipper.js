#!/usr/bin/env node
'use strict';
/**
 * shipper.js — point this at a log file and adoption is one line.
 *
 *   node scripts/shipper.js --file /var/log/auth.log \
 *     --url https://logs.example.com --key "$INGEST_KEY" --follow
 *
 * The application keeps writing the log it always wrote. This process tails it, hands each
 * line to lib/formats (the same parser the importer uses), and POSTs the resulting entries to
 * /api/log in batches, printing the signed receipt sequence numbers the server returns.
 *
 * Progress lives in a byte offset in .shipper-state.json next to the log, so a restart resumes
 * instead of re-shipping everything. Rotation and truncation are detected and restart from 0.
 *
 * Exit codes: 0 clean (including Ctrl-C), 1 unrecoverable error, 2 bad usage.
 *
 * All real logic lives in lib/shipper.js so it can be tested without a server; this file is
 * argument handling, console output and signals.
 */
const fs = require('fs');
const path = require('path');
const shipper = require('../lib/shipper');

const err = (msg) => process.stderr.write(`${msg}\n`);

function summaryLine(r) {
  const parts = [
    `${r.sent} entr${r.sent === 1 ? 'y' : 'ies'} accepted`,
    `${r.skipped} line${r.skipped === 1 ? '' : 's'} skipped`,
    `${r.batches} batch${r.batches === 1 ? '' : 'es'}`,
    `offset ${r.from} -> ${r.to}`,
  ];
  if (r.firstSeq !== null && r.firstSeq !== undefined) parts.push(`first seq ${r.firstSeq}`);
  if (r.lastSeq !== null && r.lastSeq !== undefined) parts.push(`last seq ${r.lastSeq}`);
  if (r.rejected) parts.push(`${r.rejected} rejected by server`);
  if (r.rotated) parts.push('rotation handled');
  return `done: ${parts.join(', ')}`;
}

async function run(opts) {
  const abs = path.resolve(opts.file);
  if (!fs.existsSync(abs)) {
    err(`shipper: no such log file: ${abs}`);
    return 1;
  }

  let endpoint = null;
  try {
    endpoint = opts.url ? shipper.resolveEndpoint(opts.url) : null;
  } catch (e) {
    err(`shipper: ${e.message}`);
    return 2;
  }

  const detected = shipper.detectFileFormat(abs);
  const format = opts.format === 'auto' ? (detected === 'unknown' ? 'auto' : detected) : opts.format;
  const stateFile = shipper.statePathFor(abs, opts.state);
  const state = shipper.readState(stateFile);

  if (state.corrupt) {
    err(`shipper: state file ${stateFile} was unreadable (${state.error}); starting from offset 0`);
  }

  const resumeOffset = state.file && path.resolve(state.file) === abs ? state.offset : 0;

  console.log(
    shipper.formatBanner({
      file: abs,
      format,
      formatSource: opts.format === 'auto' ? 'auto-detected' : 'from --format',
      offset: resumeOffset,
      endpoint,
      batch: opts.batch,
      follow: opts.follow,
      stateFile,
      dryRun: opts.dryRun,
    })
  );

  if (opts.format !== 'auto' && detected !== 'unknown' && detected !== opts.format) {
    err(`shipper: warning: this file looks like ${detected}, not ${opts.format} — mismatched lines will be skipped`);
  }

  // Ctrl-C is a clean stop: finish the batch in flight, flush the tail, exit 0. A second
  // Ctrl-C is the operator saying "now", and gets the conventional 130.
  let stopping = false;
  const onSignal = (sig) => {
    if (stopping) {
      err('\nshipper: second interrupt — exiting without flushing');
      process.exit(130);
    }
    stopping = true;
    err(`\nshipper: ${sig} — finishing the current batch, then stopping`);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const base = {
    file: abs,
    url: opts.url,
    key: opts.key,
    format,
    batch: opts.batch,
    stateFile,
    dryRun: opts.dryRun,
    state,
    say: (message) => console.log(message),
  };

  if (!opts.follow) {
    const result = await shipper.shipPass(base);
    console.log(summaryLine(result));
    return 0;
  }

  if (opts.dryRun) {
    err('shipper: dry-run + follow — parsing continuously, sending nothing, writing no state');
  }

  const result = await shipper.runFollow({ ...base, interval: opts.interval, stop: () => stopping });
  console.log(summaryLine(result));
  console.log(`stopped cleanly after ${result.passes} pass${result.passes === 1 ? '' : 'es'}`);
  return 0;
}

async function main(argv) {
  let opts;
  try {
    opts = shipper.parseArgs(argv);
  } catch (e) {
    err(`shipper: ${e.message}\n`);
    process.stderr.write(shipper.USAGE);
    return 2;
  }

  if (opts.help) {
    process.stdout.write(shipper.USAGE);
    return 0;
  }

  try {
    return await run(opts);
  } catch (e) {
    err(`shipper: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, summaryLine };
