#!/usr/bin/env node
'use strict';
/**
 * import-logs.js — put a real server log file on the chain.
 *
 *   node scripts/import-logs.js samples/auth.log
 *   node scripts/import-logs.js /var/log/nginx/access.log --max 500
 *   node scripts/import-logs.js samples/syslog.log --dry-run
 *
 * Each line goes through lib/formats, which knows the sshd / nginx / syslog
 * grammars and refuses anything it cannot account for; refusals are counted as
 * skipped, never guessed at. Entries are written with store.appendMany so they
 * chain, receipt and anchor exactly like every other entry.
 */
const fs = require('fs');
const path = require('path');
const { parseLine, detectFormat } = require('../lib/formats');

/**
 * Read one file, parse it, append the survivors.
 * `max` caps how many (non-blank) lines are read, `dryRun` parses without writing.
 */
function importFile({ file, max, dryRun = false } = {}) {
  if (!file) throw new Error('importFile({ file }) requires a path');

  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`no such log file: ${abs}`);

  // Resolved here, not at module load, so WITNESS_DATA set by a caller (or a test)
  // is the directory the entries actually land in.
  const store = require('../lib/store');

  const all = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  const limit = Number.isInteger(max) && max > 0 ? max : null;
  const lines = limit ? all.slice(0, limit) : all;
  const format = detectFormat(lines);

  const entries = [];
  const skippedLines = [];
  for (const line of lines) {
    const hit = parseLine(line);
    if (!hit || !hit.ts) {
      skippedLines.push(line);
      continue;
    }
    const { format: _detected, ...entry } = hit;
    entries.push(entry);
  }

  const written = dryRun || entries.length === 0 ? 0 : store.appendMany(entries);

  return {
    file: abs,
    format,
    dryRun: Boolean(dryRun),
    max: limit,
    linesRead: lines.length,
    parsed: entries.length,
    skipped: skippedLines.length,
    skippedLines,
    written,
    firstTs: entries.length ? entries[0].ts : null,
    lastTs: entries.length ? entries[entries.length - 1].ts : null,
    entries,
  };
}

const USAGE = `usage: node scripts/import-logs.js <file> [--max N] [--dry-run]

  <file>       log file to import (sshd, nginx combined, or RFC 3164 syslog)
  --max N      read at most N non-blank lines
  --dry-run    parse and report, write nothing
`;

function parseArgs(argv) {
  const opts = { file: null, max: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run' || arg === '-n') {
      opts.dryRun = true;
    } else if (arg === '--max' || arg.startsWith('--max=')) {
      const raw = arg === '--max' ? argv[(i += 1)] : arg.slice('--max='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--max needs a positive integer, got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}`);
      opts.max = n;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (!opts.file) {
      opts.file = arg;
    } else {
      throw new Error('one file at a time');
    }
  }
  return opts;
}

function formatSummary(r) {
  const rows = [
    ['file', r.file],
    ['format', r.format],
    ['lines read', String(r.linesRead)],
    ['parsed', String(r.parsed)],
    ['skipped', String(r.skipped)],
    ['first timestamp', r.firstTs || '-'],
    ['last timestamp', r.lastTs || '-'],
    ['written', r.dryRun ? '0 (dry run)' : `${r.written} entries`],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)} : ${v}`).join('\n');
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!opts.file) {
    process.stderr.write(USAGE);
    return 2;
  }
  const result = importFile({ file: opts.file, max: opts.max, dryRun: opts.dryRun });
  console.log(formatSummary(result));
  if (result.skipped) {
    console.log(`skipped lines (first ${Math.min(3, result.skipped)}):`);
    for (const line of result.skippedLines.slice(0, 3)) console.log(`  ! ${line.slice(0, 120)}`);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`import-logs: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { importFile, main, parseArgs, formatSummary };
