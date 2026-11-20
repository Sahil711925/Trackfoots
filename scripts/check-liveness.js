#!/usr/bin/env node
'use strict';
/**
 * check-liveness.js — alarm for the one failure the chain cannot catch.
 *
 * Tampering breaks the past; blocking the anchor only breaks the future. `cli.js verify` would
 * happily print VERIFIED while every new entry is unwitnessed, so this checks the other end:
 * has the ledger kept up with the log, and is it still moving?
 *
 *   node scripts/check-liveness.js
 *   node scripts/check-liveness.js --max-age 900 --max-unanchored 100
 *   node scripts/check-liveness.js --json
 *
 * Exit: 0 healthy, 2 stale (or a ledger sequence gap), 1 bad usage.
 *
 * Deliberately does NOT require lib/env: env.js overrides WITNESS_DATA from .env, which would
 * make `WITNESS_DATA=/tmp/x node scripts/check-liveness.js` quietly inspect the wrong directory.
 */
const { checkLiveness } = require('../lib/liveness');

const EXIT_HEALTHY = 0;
const EXIT_USAGE = 1;
const EXIT_STALE = 2;

const USAGE = `Usage: node scripts/check-liveness.js [options]

  --max-age <seconds>     alert when the last batch is older than this (default 3600)
  --max-unanchored <n>    alert above this many unwitnessed entries (default 200)
  --json                  print the raw report as JSON
  -h, --help              show this help

Exit codes: 0 healthy, 2 stale, 1 bad usage.
Reads WITNESS_DATA (default: ./data).`;

function parseArgs(argv) {
  const opts = { json: false, maxAgeSeconds: undefined, maxUnanchored: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    switch (arg) {
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--max-age': {
        const raw = inline !== undefined ? inline : argv[++i];
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--max-age needs a positive number of seconds, got "${raw}"`);
        opts.maxAgeSeconds = n;
        break;
      }
      case '--max-unanchored': {
        const raw = inline !== undefined ? inline : argv[++i];
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) throw new Error(`--max-unanchored needs a number >= 0, got "${raw}"`);
        opts.maxUnanchored = n;
        break;
      }
      default:
        throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  return opts;
}

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s) => paint('31;1', s);
const green = (s) => paint('32;1', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const age = (s) => {
  if (s === null) return 'never';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
};

function printReport(r) {
  const out = [];
  out.push(bold('Trackfoots liveness') + dim(`  ${r.dataDir}`));
  out.push(dim(`checked ${r.checkedAt}`));
  out.push('');

  const row = (label, value, note = '') =>
    out.push(`  ${pad(label, 18)} ${pad(value, 22)} ${note ? dim(note) : ''}`.trimEnd());

  row('entries', String(r.totalEntries), r.corruptLines ? `${r.corruptLines} unparseable line(s)` : '');
  row(
    'anchored through',
    r.anchoredBatches ? `seq ${r.lastAnchoredSeq}` : 'nothing yet',
    r.anchoredBatches ? `${plural(r.anchoredBatches, 'batch', 'batches')} | last batch ${r.lastBatch ?? '?'}` : ''
  );
  row(
    'unanchored',
    String(r.unanchoredEntries),
    `${r.unanchoredEntries > r.thresholds.maxUnanchored ? red('over') : 'limit'} ${r.thresholds.maxUnanchored}`
  );
  row('last anchor', age(r.lastAnchorAgeSeconds), r.lastAnchorTs || '');
  row(
    'sequence gaps',
    String(r.sequenceGaps.length),
    r.sequenceGaps.length ? red('ledger lost a batch') : 'contiguous'
  );
  out.push('');

  if (r.stale) {
    out.push(red('STALE') + dim('  anchoring has stopped while the log keeps growing'));
    for (const reason of r.reasons) out.push(`  - ${reason}`);
  } else if (!r.healthy) {
    out.push(yellow('DEGRADED') + dim('  no staleness, but the ledger is not clean'));
    for (const reason of r.reasons) out.push(`  - ${reason}`);
  } else {
    out.push(green('HEALTHY') + dim('  the witness is keeping up'));
    for (const reason of r.reasons) out.push(`  - ${reason}`);
  }
  for (const note of r.notes) out.push(dim(`  note: ${note}`));

  const worstGap = r.sequenceGaps[0];
  if (worstGap) {
    out.push('');
    out.push(`  first gap: row ${worstGap.index}  ${worstGap.reason}`);
  }

  console.log(out.join('\n'));
  console.log('');
  console.log(dim(`exit ${r.healthy ? EXIT_HEALTHY : EXIT_STALE} (${r.healthy ? 'healthy' : r.stale ? 'stale' : 'degraded'})`));
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`check-liveness: ${err.message}\n`);
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (opts.help) {
    console.log(USAGE);
    return EXIT_HEALTHY;
  }

  const report = checkLiveness({
    maxAgeSeconds: opts.maxAgeSeconds,
    maxUnanchored: opts.maxUnanchored,
  });

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  return report.healthy ? EXIT_HEALTHY : EXIT_STALE;
}

if (require.main === module) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (err) {
    console.error(`check-liveness: ${err.message}`);
    code = EXIT_USAGE;
  }
  process.exitCode = code;
}

module.exports = { main, parseArgs };
