'use strict';
/**
 * shipper.js — incremental, resumable shipping of a real log file into the ingest API.
 *
 * The point of this module is adoption: an operator points it at /var/log/auth.log and their
 * application code never changes. Everything here is deliberately dependency-free and
 * side-effect-free at require time so `scripts/shipper.js` can be tested without a server.
 *
 * Division of labour:
 *   lib/formats.js   decides what a line MEANS (sshd / nginx / syslog grammar)
 *   this module      decides what has already been sent, what to send next, and what to do
 *                    when the network, the file or the server misbehaves
 *
 * Offsets are BYTE offsets into the file. The state file remembers the offset of the byte
 * immediately after the last line that was accepted by the server, so a restart resumes
 * instead of re-shipping the whole file. Two real-world cases are handled explicitly:
 *
 *   file grew            -> read from the stored offset
 *   file shrunk/rotated  -> size < offset (or a new inode) means the path now names a
 *                           different file: restart from 0 and say so, never silently skip
 *
 * Delivery is at-least-once, per batch: the offset only moves after the server returns 2xx
 * for that batch, so a crash between POST and state-write can duplicate the one batch that
 * was in flight. It can never lose a batch. Receipts (seq + content hash) make duplicates
 * identifiable after the fact.
 *
 * Unparseable lines are counted and skipped, never guessed at — same rule as import-logs.
 */
const fs = require('fs');
const path = require('path');
const { parseLine, detectFormat } = require('./formats');

const DEFAULT_BATCH = 50;
const MAX_BATCH = 1000; // server-side ingest limit
const DEFAULT_STATE_NAME = '.shipper-state.json';
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const FORMATS = ['auto', 'sshd', 'nginx', 'syslog'];

const noop = () => {};
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const USAGE = `usage: node scripts/shipper.js --file <path> --url <base-url> --key <api-key> [options]

  --file <path>       log file to ship (sshd, nginx combined, or syslog)
  --url <base-url>    ingest base URL, e.g. http://localhost:5173 (POSTs to /api/log)
  --key <api-key>     value for the x-api-key header (INGEST_KEY on the server)
  --follow, -f        keep tailing the file (poll every 1000ms) until SIGINT/Ctrl-C
  --format <name>     auto | sshd | nginx | syslog   (default: auto)
  --batch <n>         entries per POST, 1..1000          (default: 50)
  --state <file>      resume-offset file (default: .shipper-state.json next to the log)
  --dry-run           parse and report, send nothing, write no state
  --help, -h          this text

exit codes: 0 clean (including Ctrl-C), 1 unrecoverable error, 2 bad usage
`;

// --------------------------------------------------------------------------- CLI args

function flagValue(arg, name, argv, i) {
  if (arg === name) {
    const v = argv[i + 1];
    if (v === undefined || v === '' || v.startsWith('--')) {
      throw new Error(`${name} needs a value`);
    }
    return { value: v, step: 1 };
  }
  if (arg.startsWith(`${name}=`)) {
    const v = arg.slice(name.length + 1);
    if (v === '') throw new Error(`${name} needs a value`);
    return { value: v, step: 0 };
  }
  return null;
}

function parseArgs(argv) {
  const opts = {
    file: null,
    url: null,
    key: null,
    follow: false,
    format: 'auto',
    batch: DEFAULT_BATCH,
    state: null,
    dryRun: false,
    help: false,
    interval: DEFAULT_INTERVAL_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--follow' || arg === '-f') {
      opts.follow = true;
      continue;
    }
    if (arg === '--dry-run' || arg === '-n') {
      opts.dryRun = true;
      continue;
    }

    const file = flagValue(arg, '--file', argv, i);
    if (file) {
      opts.file = file.value;
      i += file.step;
      continue;
    }
    const url = flagValue(arg, '--url', argv, i);
    if (url) {
      opts.url = url.value;
      i += url.step;
      continue;
    }
    const key = flagValue(arg, '--key', argv, i);
    if (key) {
      opts.key = key.value;
      i += key.step;
      continue;
    }
    const state = flagValue(arg, '--state', argv, i);
    if (state) {
      opts.state = state.value;
      i += state.step;
      continue;
    }
    const format = flagValue(arg, '--format', argv, i);
    if (format) {
      const f = format.value.toLowerCase();
      if (!FORMATS.includes(f)) {
        throw new Error(`--format must be one of ${FORMATS.join(', ')}, got ${JSON.stringify(format.value)}`);
      }
      opts.format = f;
      i += format.step;
      continue;
    }
    const batch = flagValue(arg, '--batch', argv, i);
    if (batch) {
      const n = Number(batch.value);
      if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH) {
        throw new Error(`--batch needs an integer 1..${MAX_BATCH}, got ${JSON.stringify(batch.value)}`);
      }
      opts.batch = n;
      i += batch.step;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected argument: ${arg} (use --file <path>)`);
  }

  if (!opts.help) {
    if (!opts.file) throw new Error('--file is required');
    if (!opts.dryRun && !opts.url) throw new Error('--url is required unless --dry-run');
    if (!opts.dryRun && !opts.key) throw new Error('--key is required unless --dry-run');
  }
  return opts;
}

/** Accept either a base URL or the endpoint itself; always return the /api/log endpoint. */
function resolveEndpoint(url) {
  if (url === undefined || url === null || url === '') {
    throw new Error('an ingest URL is required (e.g. http://localhost:5173)');
  }
  const trimmed = String(url).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    throw new Error(`--url must be an http(s) URL, got ${JSON.stringify(url)}`);
  }
  return /\/api\/(log|ingest)$/i.test(trimmed) ? trimmed : `${trimmed}/api/log`;
}

function statePathFor(file, state) {
  if (state) return path.resolve(state);
  return path.join(path.dirname(path.resolve(file)), DEFAULT_STATE_NAME);
}

// --------------------------------------------------------------------------- state file

function emptyState() {
  return { file: null, ino: null, offset: 0, format: null, sent: 0, skipped: 0, updatedAt: null };
}

/**
 * A missing state file is a fresh start. A CORRUPT one is also a fresh start, but flagged, so
 * the caller can say so out loud instead of silently re-shipping a whole file.
 */
function readState(stateFile) {
  const base = emptyState();
  let raw;
  try {
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return base;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    const offset = Number(parsed.offset);
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`invalid offset: ${parsed.offset}`);
    return {
      file: typeof parsed.file === 'string' ? parsed.file : null,
      ino: parsed.ino === null || parsed.ino === undefined ? null : String(parsed.ino),
      offset,
      format: typeof parsed.format === 'string' ? parsed.format : null,
      sent: Number.isFinite(Number(parsed.sent)) ? Number(parsed.sent) : 0,
      skipped: Number.isFinite(Number(parsed.skipped)) ? Number(parsed.skipped) : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch (err) {
    return { ...base, corrupt: true, error: err.message };
  }
}

/** Write-then-rename so a crash mid-write cannot leave a half state file behind. */
function writeState(stateFile, state) {
  const body = JSON.stringify(
    {
      version: 1,
      file: state.file,
      ino: state.ino,
      offset: state.offset,
      format: state.format,
      sent: state.sent,
      skipped: state.skipped,
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  );
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${body}\n`);
  fs.renameSync(tmp, stateFile);
}

// --------------------------------------------------------------------------- reading bytes

function statFile(file) {
  try {
    return fs.statSync(file, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no such log file: ${file}`);
    throw err;
  }
}

/** Format vote over the head of the file (for the banner and for explicit-format sanity). */
function detectFileFormat(file, { sample = 200, maxBytes = 256 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no such log file: ${file}`);
    throw err;
  }
  try {
    const size = Number(fs.fstatSync(fd).size);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split(/\r?\n/);
    // The cap can land mid-line; the partial tail must not vote for anything.
    if (len < size && lines.length > 1) lines.pop();
    return detectFormat(lines.filter((line) => line.trim() !== ''), { sample });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read whole lines starting at `offset`.
 *
 * Returns complete lines (with their byte start/end), the offset just past the last complete
 * line, and any trailing bytes that do not yet end in a newline. That tail is NOT consumed:
 * a writer may be halfway through the line, and shipping half a log line would be a lie.
 */
function readChunk(file, offset, { maxBytes = DEFAULT_MAX_BYTES, ino = null } = {}) {
  const st = statFile(file);
  const size = Number(st.size);
  const currentIno = st.ino === 0n ? null : String(st.ino);

  let start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  let rotated = false;

  if (start > size) {
    // The file is shorter than the place we had read to: truncate or copytruncate rotation.
    start = 0;
    rotated = true;
  } else if (
    !rotated &&
    ino &&
    String(ino) !== '0' &&
    currentIno &&
    String(ino) !== currentIno
  ) {
    // Same path, different file (rename rotation). Size alone would not catch this.
    start = 0;
    rotated = true;
  }

  const remaining = size - start;
  if (remaining <= 0) {
    return { start, size, ino: currentIno, nextOffset: start, lines: [], partial: null, eof: true, rotated };
  }

  const firstLen = Math.min(remaining, maxBytes);
  const fd = fs.openSync(file, 'r');
  let buf;
  try {
    buf = Buffer.allocUnsafe(firstLen);
    fs.readSync(fd, buf, 0, firstLen, start);
    let cut = buf.lastIndexOf(0x0a);
    if (cut === -1 && firstLen < remaining) {
      // One line longer than the window. Read the rest rather than stalling at this offset.
      const rest = Buffer.allocUnsafe(remaining);
      fs.readSync(fd, rest, 0, remaining, start);
      buf = rest;
      cut = buf.lastIndexOf(0x0a);
    }
    if (cut === -1) {
      return {
        start,
        size,
        ino: currentIno,
        nextOffset: start,
        lines: [],
        partial: buf.toString('utf8'),
        eof: true,
        rotated,
      };
    }

    const lines = [];
    let pos = 0;
    while (pos <= cut) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1 || nl > cut) break;
      let text = buf.toString('utf8', pos, nl);
      if (text.endsWith('\r')) text = text.slice(0, -1);
      if (text.trim() !== '') lines.push({ text, start: start + pos, end: start + nl + 1 });
      pos = nl + 1;
    }
    const nextOffset = start + pos;
    // `eof` means the window reached the end of the file — the tail after the last newline
    // is then the only thing left, even though it is not a whole line yet.
    const atEnd = start + buf.length >= size;
    return {
      start,
      size,
      ino: currentIno,
      nextOffset,
      lines,
      partial: nextOffset < size ? buf.toString('utf8', nextOffset - start) : null,
      eof: atEnd,
      rotated,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// --------------------------------------------------------------------------- HTTP

/** 4xx other than timeout/rate-limit means retrying cannot help: the key or the body is wrong. */
function isRetryable(status) {
  if (!Number.isInteger(status)) return true; // network error / abort
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function snippet(text, max = 300) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * POST one batch, retrying transient failures with exponential backoff.
 * `retries` counts ATTEMPTS, not retries: 3 means one try and two backoff retries.
 */
async function postEntries({
  endpoint,
  key,
  entries,
  fetchImpl = globalThis.fetch,
  retries = DEFAULT_RETRY_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  sleep = sleepMs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!endpoint) throw new Error('postEntries requires an endpoint');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available (Node 22+ required)');
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('postEntries requires a non-empty entries array');

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let status = null;
    let bodyText = '';
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ entries }),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      status = res.status;
      bodyText = typeof res.text === 'function' ? await res.text() : '';

      if (res.ok) {
        let json = null;
        try {
          json = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          json = null;
        }
        if (!json || typeof json.accepted !== 'number') {
          throw Object.assign(
            new Error(`ingest returned ${status} but no JSON receipt body: ${snippet(bodyText)}`),
            { permanent: true }
          );
        }
        return {
          status,
          accepted: json.accepted,
          rejected: Array.isArray(json.rejected) ? json.rejected : [],
          receipts: Array.isArray(json.receipts) ? json.receipts : [],
          maxBatch: json.maxBatch,
        };
      }

      const detail = snippet(bodyText);
      const err = new Error(`ingest returned ${status}: ${detail || '(empty body)'}`);
      if (!isRetryable(status)) {
        err.permanent = true;
        err.status = status;
        throw err;
      }
      lastError = err;
    } catch (err) {
      if (err && err.permanent) throw err;
      lastError = err;
      if (status === null) status = null;
    }

    if (attempt < retries) await sleep(retryBaseMs * 2 ** (attempt - 1));
  }

  throw new Error(
    `POST ${endpoint} failed after ${retries} attempts: ${lastError ? lastError.message : 'unknown error'}`
  );
}

// --------------------------------------------------------------------------- shipping

/**
 * One incremental pass: read from the stored offset, parse, send in batches, persist progress
 * after each accepted batch.
 *
 * @returns {Promise<object>} summary; `state` is the same object the caller passed in, so a
 *          follow loop can keep resuming without re-reading the file on disk.
 */
async function shipPass(options = {}) {
  const {
    file,
    url,
    key,
    format = 'auto',
    batch = DEFAULT_BATCH,
    stateFile,
    dryRun = false,
    follow = false,
    fetchImpl = globalThis.fetch,
    retries = DEFAULT_RETRY_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    sleep = sleepMs,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    say = noop,
    state: givenState,
  } = options;

  if (!file) throw new Error('shipPass requires a file');
  if (!FORMATS.includes(format)) throw new Error(`unknown format: ${format}`);
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
    throw new Error(`batch must be an integer 1..${MAX_BATCH}, got ${batch}`);
  }

  const abs = path.resolve(file);
  statFile(abs); // fail loudly and early on a missing file

  const endpoint = dryRun && !url ? null : resolveEndpoint(url);
  if (!dryRun && !key) throw new Error('an api key is required unless --dry-run');

  const statePath = stateFile ? path.resolve(stateFile) : statePathFor(abs);
  const persistEnabled = !dryRun;
  const state = givenState || readState(statePath);

  if (state.file && path.resolve(state.file) !== abs) {
    say(`state was for ${state.file} — starting this file from offset 0`);
    // The counters belong to that other log too; carrying them over would make the state
    // file claim this log had already shipped entries it never saw.
    state.offset = 0;
    state.ino = null;
    state.format = null;
    state.sent = 0;
    state.skipped = 0;
  }
  state.file = abs;

  let from = Number.isInteger(state.offset) && state.offset >= 0 ? state.offset : 0;
  state.offset = from;

  // `cursor` is where reading has reached; `committed` is where the SERVER has accepted up to.
  // Only `committed` may be persisted, or a failed batch would be skipped on the next pass.
  let cursor = from;
  let committed = from;
  let currentIno = state.ino;
  let rotated = false;
  let linesRead = 0;
  let parsed = 0;
  let skipped = 0;
  let skippedPending = 0;
  let sent = 0;
  let rejected = 0;
  let batches = 0;
  let firstSeq = null;
  let lastSeq = null;
  let acceptedCommitted = 0;
  let skippedCommitted = 0;
  const baseSent = Number(state.sent) || 0;
  const baseSkipped = Number(state.skipped) || 0;

  let pending = [];
  let batchStart = null;
  let reportedRotation = false;

  const persist = () => {
    if (!persistEnabled) return;
    state.offset = committed;
    state.ino = currentIno;
    state.format = format;
    state.sent = baseSent + acceptedCommitted;
    state.skipped = baseSkipped + skippedCommitted;
    writeState(statePath, state);
  };

  const flush = async (endOffset) => {
    if (pending.length === 0) return;
    const entries = pending;
    pending = [];
    const startOffset = batchStart === null ? cursor : batchStart;
    batchStart = null;
    let accepted = entries.length;

    if (dryRun) {
      say(
        `[dry-run] ${entries.length} entries -> would POST ${endpoint || '(no url given)'} ` +
          `(bytes ${startOffset}..${endOffset})`
      );
      sent += entries.length;
    } else {
      const out = await postEntries({
        endpoint,
        key,
        entries,
        fetchImpl,
        retries,
        retryBaseMs,
        sleep,
        timeoutMs,
      });

      accepted = out.accepted;
      sent += out.accepted;
      rejected += out.rejected.length;
      if (out.rejected.length > 0) {
        const detail = out.rejected
          .slice(0, 3)
          .map((r) => `#${r.index} ${r.reason}`)
          .join('; ');
        say(`server rejected ${out.rejected.length} entr${out.rejected.length === 1 ? 'y' : 'ies'}: ${detail}`);
      }
      const r0 = out.receipts[0];
      const rN = out.receipts[out.receipts.length - 1];
      if (r0 && firstSeq === null) firstSeq = r0.seq;
      if (rN) lastSeq = rN.seq;
      say(
        `sent ${entries.length} entries -> ${out.status} accepted ${out.accepted}; ` +
          `receipts ${out.receipts.length}, first seq ${r0 ? r0.seq : '-'}`
      );
    }

    batches += 1;
    cursor = endOffset;
    committed = endOffset; // the server has this batch: safe to resume from here
    acceptedCommitted += accepted;
    skippedCommitted += skippedPending;
    skippedPending = 0;
    persist();
    if (dryRun) state.offset = committed;
  };

  try {
    for (;;) {
      const chunk = readChunk(abs, cursor, { maxBytes, ino: currentIno });
      currentIno = chunk.ino;
      if (chunk.rotated) {
        rotated = true;
        const resetFrom = cursor;
        cursor = 0;
        committed = 0;
        from = 0; // this pass really starts at the top of the new file
        state.offset = 0;
        state.ino = chunk.ino;
        if (!reportedRotation) {
          reportedRotation = true;
          say(
            `log rotated or truncated: stored offset ${resetFrom} is beyond the file end ` +
              `(${chunk.size} bytes) — restarting from offset 0`
          );
        }
        continue;
      }

      const lines = chunk.lines.slice();
      if (!follow && chunk.eof && chunk.partial && chunk.partial.trim() !== '') {
        // Not following: the file will not grow under us, so its last unterminated line is
        // a real line, not a half-written one.
        lines.push({ text: chunk.partial, start: chunk.nextOffset, end: chunk.size, partial: true });
      }

      if (lines.length === 0) {
        cursor = Math.max(cursor, chunk.nextOffset);
        if (chunk.eof) {
          committed = cursor;
          persist();
          break;
        }
        continue;
      }

      for (const line of lines) {
        cursor = line.end;
        linesRead += 1;

        const hit = parseLine(line.text);
        if (!hit || !hit.ts) {
          skipped += 1;
          skippedPending += 1;
          continue;
        }
        if (format !== 'auto' && hit.format !== format) {
          skipped += 1;
          skippedPending += 1;
          continue;
        }

        const { format: _matched, ...entry } = hit;
        if (pending.length === 0) batchStart = line.start;
        pending.push(entry);
        parsed += 1;
        if (pending.length >= batch) await flush(cursor);
      }

      if (chunk.eof) {
        cursor = Math.max(cursor, chunk.nextOffset);
        break;
      }
    }

    await flush(cursor);

    // A pass that ends with only skipped lines (or none at all) still needs to move the
    // offset forward, otherwise follow mode re-reads the same junk forever.
    skippedCommitted += skippedPending;
    skippedPending = 0;
    committed = cursor;
    persist();
    if (dryRun) state.offset = committed;
  } finally {
    // Never lose the batches that already succeeded, even if a later one threw. The failed
    // batch is re-read from `committed` on the next pass.
    if (dryRun) {
      state.offset = committed;
    } else {
      try {
        persist();
      } catch {
        /* a state write failing here must not mask the original error */
      }
    }
  }

  return {
    file: abs,
    format,
    from,
    to: committed,
    rotated,
    linesRead,
    parsed,
    skipped,
    sent,
    rejected,
    batches,
    firstSeq,
    lastSeq,
    state,
  };
}

/** Poll, ship, sleep — until `stop()` says otherwise. Then flush the tail and return. */
async function runFollow(options = {}) {
  const {
    interval = DEFAULT_INTERVAL_MS,
    stop = () => false,
    sleep = sleepMs,
    say = noop,
    state,
    ...rest
  } = options;

  let passes = 0;
  const totals = { sent: 0, skipped: 0, batches: 0, rejected: 0 };

  while (!stop()) {
    const r = await shipPass({ ...rest, say, state, follow: true });
    passes += 1;
    totals.sent += r.sent;
    totals.skipped += r.skipped;
    totals.batches += r.batches;
    totals.rejected += r.rejected;
    if (stop()) break;
    await sleep(interval);
  }

  // Final non-follow pass: a line written without its newline just before Ctrl-C is complete
  // as far as we are concerned, so ship it rather than leaving it for nobody.
  const last = await shipPass({ ...rest, say, state, follow: false });
  passes += 1;
  totals.sent += last.sent;
  totals.skipped += last.skipped;
  totals.batches += last.batches;
  totals.rejected += last.rejected;

  return { ...last, passes, totals };
}

// --------------------------------------------------------------------------- presentation

function formatBanner({ file, format, formatSource, offset, endpoint, batch, follow, stateFile, dryRun }) {
  const rows = [
    ['file', file],
    ['format', formatSource ? `${format} (${formatSource})` : format],
    ['offset', offset > 0 ? `${offset} (resuming)` : '0 (fresh start)'],
    ['endpoint', endpoint || '-'],
    ['batch', `${batch} per POST, follow ${follow ? 'on' : 'off'}`],
    ['state', dryRun ? `${stateFile} (not written in dry-run)` : stateFile],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`);
  return ['trackfoots shipper', ...lines, dryRun ? '  mode    dry run — nothing will be sent' : null]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  // constants
  DEFAULT_BATCH,
  MAX_BATCH,
  DEFAULT_STATE_NAME,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_MS,
  FORMATS,
  USAGE,
  // args / config
  parseArgs,
  resolveEndpoint,
  statePathFor,
  // state
  readState,
  writeState,
  // file
  detectFileFormat,
  readChunk,
  // http
  isRetryable,
  postEntries,
  // loops
  shipPass,
  runFollow,
  // output
  formatBanner,
};
