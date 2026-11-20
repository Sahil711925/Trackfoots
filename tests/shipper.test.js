'use strict';
/**
 * shipper.test.js — lib/shipper.js and the CLI, no server required.
 *
 * The network is always a fake `fetchImpl` except in the one test that boots a real
 * http.Server on an ephemeral port and checks the request the shipper actually puts on
 * the wire (header, body shape, receipts). Nothing here touches data/, .env, port 5173 or
 * the repo's state files: every file lives in its own temp directory.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const REPO = path.resolve(__dirname, '..');
const {
  parseArgs,
  resolveEndpoint,
  statePathFor,
  readState,
  writeState,
  detectFileFormat,
  readChunk,
  isRetryable,
  postEntries,
  shipPass,
  runFollow,
  formatBanner,
  USAGE,
  DEFAULT_BATCH,
  MAX_BATCH,
} = require(path.join(REPO, 'lib', 'shipper.js'));
const { parseLine } = require(path.join(REPO, 'lib', 'formats.js'));

const dirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-shipper-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const authLine = (user, port = 50000) =>
  `Nov 20 02:14:07 web-01 sshd[2201]: Accepted publickey for ${user} from 103.21.44.9 port ${port} ssh2`;

const SAMPLE = fs.readFileSync(path.join(REPO, 'samples', 'auth.log'), 'utf8').split(/\r?\n/).filter(Boolean);
const parsedCount = (lines) => lines.filter((line) => parseLine(line)).length;

/** Fake ingest endpoint. Records calls; can fail the first N attempts or reject entries. */
function fakeIngest({ failTimes = 0, failStatus = 503, accepted = null, rejected = [], status = 202 } = {}) {
  const calls = [];
  let seq = 1000;
  const fn = async (endpoint, init) => {
    const body = JSON.parse(init.body);
    calls.push({ endpoint, headers: init.headers, entries: body.entries, raw: init.body });
    if (calls.length <= failTimes) {
      const message = failStatus === 401 ? 'invalid or missing x-api-key' : 'upstream exploded';
      return { ok: false, status: failStatus, text: async () => JSON.stringify({ error: message }) };
    }
    const n = accepted === null ? body.entries.length : accepted;
    const receipts = Array.from({ length: n }, () => {
      seq += 1;
      return { seq, chash: `chash-${seq}`, sig: 'x', sigAlg: 'hmac-sha256' };
    });
    return {
      ok: true,
      status,
      text: async () => JSON.stringify({ accepted: n, rejected, receipts, maxBatch: 1000 }),
    };
  };
  fn.calls = calls;
  return fn;
}

// --------------------------------------------------------------------------- args

test('parseArgs defaults match the documented CLI', () => {
  const opts = parseArgs(['--file', 'a.log', '--url', 'http://localhost:5199', '--key', 'k']);
  assert.equal(opts.file, 'a.log');
  assert.equal(opts.url, 'http://localhost:5199');
  assert.equal(opts.key, 'k');
  assert.equal(opts.follow, false);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.format, 'auto');
  assert.equal(opts.batch, DEFAULT_BATCH);
  assert.equal(opts.state, null);
  assert.equal(opts.interval, 1000);
  assert.equal(opts.help, false);
});

test('parseArgs accepts --flag=value, -f and every documented flag', () => {
  const opts = parseArgs([
    '--file=/var/log/auth.log',
    '--url=https://logs.example.com/',
    '--key=secret',
    '--follow',
    '--format',
    'sshd',
    '--batch=250',
    '--state=/tmp/s.json',
    '--dry-run',
  ]);
  assert.equal(opts.file, '/var/log/auth.log');
  assert.equal(opts.url, 'https://logs.example.com/');
  assert.equal(opts.key, 'secret');
  assert.equal(opts.follow, true);
  assert.equal(opts.format, 'sshd');
  assert.equal(opts.batch, 250);
  assert.equal(opts.state, '/tmp/s.json');
  assert.equal(opts.dryRun, true);

  assert.equal(parseArgs(['--file', 'a', '--url', 'http://x', '--key', 'k', '-f']).follow, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs refuses missing credentials, bad batch sizes, bad formats and stray args', () => {
  assert.throws(() => parseArgs([]), /--file is required/);
  assert.throws(() => parseArgs(['--file', 'a.log']), /--url is required unless --dry-run/);
  assert.throws(() => parseArgs(['--file', 'a.log', '--url', 'http://x']), /--key is required unless --dry-run/);
  assert.throws(() => parseArgs(['--file', 'a.log', '--batch', '0']), /--batch needs an integer 1\.\.1000/);
  assert.throws(() => parseArgs(['--file', 'a.log', '--batch', String(MAX_BATCH + 1)]), /--batch/);
  assert.throws(() => parseArgs(['--file', 'a.log', '--batch', '2.5']), /--batch/);
  assert.throws(() => parseArgs(['--file', 'a.log', '--batch']), /--batch needs a value/);
  assert.throws(() => parseArgs(['--file', 'a.log', '--format', 'apache']), /--format must be one of/);
  assert.throws(() => parseArgs(['--file', 'a.log', '--bogus']), /unknown flag: --bogus/);
  assert.throws(() => parseArgs(['a.log']), /unexpected argument/);

  // dry-run only needs the file
  assert.equal(parseArgs(['--file', 'a.log', '--dry-run']).dryRun, true);
});

test('resolveEndpoint accepts a base URL or the endpoint itself', () => {
  assert.equal(resolveEndpoint('http://localhost:5173'), 'http://localhost:5173/api/log');
  assert.equal(resolveEndpoint('http://localhost:5173/'), 'http://localhost:5173/api/log');
  assert.equal(resolveEndpoint('https://logs.example.com/api/log'), 'https://logs.example.com/api/log');
  assert.equal(resolveEndpoint('https://logs.example.com/api/ingest'), 'https://logs.example.com/api/ingest');
  assert.throws(() => resolveEndpoint('localhost:5173'), /http\(s\) URL/);
  assert.throws(() => resolveEndpoint(''), /required/);
});

test('statePathFor defaults next to the log and honours an explicit path', () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  assert.equal(statePathFor(file, null), path.join(dir, '.shipper-state.json'));
  assert.equal(statePathFor(file, path.join(dir, 'custom.json')), path.join(dir, 'custom.json'));
});

// --------------------------------------------------------------------------- reading bytes

test('readChunk returns complete lines with byte offsets and consumes through EOF', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.log');
  const text = `${authLine('rahul')}\n${authLine('priya')}\n`;
  fs.writeFileSync(file, text);

  const chunk = readChunk(file, 0);
  assert.equal(chunk.lines.length, 2);
  assert.equal(chunk.lines[0].text, authLine('rahul'));
  assert.equal(chunk.lines[0].start, 0);
  assert.equal(chunk.lines[1].start, text.indexOf('\n') + 1);
  assert.equal(chunk.lines[1].end, Buffer.byteLength(text));
  assert.equal(chunk.nextOffset, Buffer.byteLength(text));
  assert.equal(chunk.partial, null);
  assert.equal(chunk.eof, true);
  assert.equal(chunk.rotated, false);
});

test('readChunk never consumes an unterminated trailing line', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.log');
  const first = `${authLine('rahul')}\n`;
  const half = 'Nov 20 02:15:00 web-01 sshd[9]: Accepted publick';
  fs.writeFileSync(file, first + half);

  const chunk = readChunk(file, 0);
  assert.equal(chunk.lines.length, 1);
  assert.equal(chunk.lines[0].text, authLine('rahul'));
  assert.equal(chunk.nextOffset, Buffer.byteLength(first));
  assert.equal(chunk.partial, half);
  assert.equal(chunk.eof, true, 'the tail is at EOF but is not a line yet');
});

test('readChunk resumes from a byte offset', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.log');
  const text = `${authLine('a')}\n${authLine('b')}\n${authLine('c')}\n`;
  fs.writeFileSync(file, text);
  const offset = Buffer.byteLength(`${authLine('a')}\n`);

  const chunk = readChunk(file, offset);
  assert.deepEqual(chunk.lines.map((l) => l.text), [authLine('b'), authLine('c')]);
  assert.equal(chunk.lines[0].start, offset);
});

test('readChunk flags truncation and inode replacement as rotation', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.log');
  fs.writeFileSync(file, `${authLine('a')}\n`);

  const truncated = readChunk(file, 999_999);
  assert.equal(truncated.rotated, true);
  assert.equal(truncated.start, 0);
  assert.equal(truncated.lines.length, 1, 'a truncated file is read from the beginning');

  const swapped = readChunk(file, 0, { ino: '12345' });
  assert.equal(swapped.rotated, true, 'a different inode at the same path is a new file');
  assert.equal(swapped.start, 0);
});

test('readChunk strips CRLF and skips blank lines without losing offsets', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.log');
  const text = `\r\n${authLine('rahul')}\r\n\r\n${authLine('priya')}\r\n`;
  fs.writeFileSync(file, text);

  const chunk = readChunk(file, 0);
  assert.deepEqual(chunk.lines.map((l) => l.text), [authLine('rahul'), authLine('priya')]);
  assert.equal(chunk.nextOffset, Buffer.byteLength(text));
});

test('readChunk returns an empty chunk when the offset is at EOF', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.log');
  fs.writeFileSync(file, `${authLine('a')}\n`);
  const size = fs.statSync(file).size;
  const chunk = readChunk(file, size);
  assert.equal(chunk.lines.length, 0);
  assert.equal(chunk.eof, true);
  assert.equal(chunk.nextOffset, size);
});

// --------------------------------------------------------------------------- state

test('readState treats a missing file as a fresh start', () => {
  const dir = tmp();
  const state = readState(path.join(dir, 'missing.json'));
  assert.equal(state.offset, 0);
  assert.equal(state.file, null);
  assert.equal(state.corrupt, undefined);
});

test('readState refuses to trust a corrupt file, but does not throw', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ this is not json');
  const state = readState(file);
  assert.equal(state.offset, 0);
  assert.equal(state.corrupt, true);
  assert.match(state.error, /JSON|object/);

  fs.writeFileSync(file, JSON.stringify({ offset: -4 }));
  assert.equal(readState(file).corrupt, true);

  fs.writeFileSync(file, JSON.stringify({ offset: 12, file: 'x.log', ino: '9', sent: 3, skipped: 1 }));
  const good = readState(file);
  assert.equal(good.offset, 12);
  assert.equal(good.file, 'x.log');
  assert.equal(good.ino, '9');
  assert.equal(good.sent, 3);
});

test('writeState round-trips and leaves no temp file behind', () => {
  const dir = tmp();
  const file = path.join(dir, '.shipper-state.json');
  writeState(file, { file: path.join(dir, 'a.log'), ino: '7', offset: 4096, format: 'sshd', sent: 12, skipped: 2 });

  const back = readState(file);
  assert.equal(back.offset, 4096);
  assert.equal(back.format, 'sshd');
  assert.equal(back.sent, 12);
  assert.deepEqual(fs.readdirSync(dir), ['.shipper-state.json']);
  assert.match(back.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('detectFileFormat identifies the real sample logs', () => {
  assert.equal(detectFileFormat(path.join(REPO, 'samples', 'auth.log')), 'sshd');
  assert.equal(detectFileFormat(path.join(REPO, 'samples', 'access.log')), 'nginx');
  assert.equal(detectFileFormat(path.join(REPO, 'samples', 'syslog.log')), 'syslog');

  const dir = tmp();
  const junk = path.join(dir, 'junk.log');
  fs.writeFileSync(junk, 'not a log line\n-- MARK --\n');
  assert.equal(detectFileFormat(junk), 'unknown');
  assert.throws(() => detectFileFormat(path.join(dir, 'nope.log')), /no such log file/);
});

// --------------------------------------------------------------------------- dry run

test('--dry-run parses real lines, sends nothing and writes no state', async () => {
  const dir = tmp();
  const stateFile = path.join(dir, '.shipper-state.json');
  const lines = [];
  const r = await shipPass({
    file: path.join(REPO, 'samples', 'auth.log'),
    dryRun: true,
    stateFile,
    batch: 10,
    fetchImpl: () => {
      throw new Error('dry run must not touch the network');
    },
    say: (line) => lines.push(line),
  });

  assert.equal(r.sent, r.parsed);
  assert.equal(r.parsed, parsedCount(SAMPLE));
  assert.equal(r.skipped, SAMPLE.length - r.parsed);
  assert.equal(r.batches, Math.ceil(r.parsed / 10));
  assert.equal(r.to, fs.statSync(path.join(REPO, 'samples', 'auth.log')).size);
  assert.equal(fs.existsSync(stateFile), false, 'dry run must not create the state file');
  assert.ok(lines.some((l) => l.startsWith('[dry-run]')));
  assert.ok(lines.length >= r.batches);
});

test('an explicit --format filter skips lines that belong to another grammar', async () => {
  const dir = tmp();
  const stateFile = path.join(dir, 'state.json');
  const r = await shipPass({
    file: path.join(REPO, 'samples', 'auth.log'),
    format: 'nginx',
    dryRun: true,
    stateFile,
    say: () => {},
  });
  assert.equal(r.parsed, 0);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, SAMPLE.length);
  assert.equal(r.batches, 0);
  assert.equal(readState(stateFile).offset, 0, 'dry run still writes nothing');
});

// --------------------------------------------------------------------------- shipping

test('shipPass batches entries, sends them with the api key, and omits the parser tag', async () => {
  const dir = tmp();
  const fetchImpl = fakeIngest();
  const r = await shipPass({
    file: path.join(REPO, 'samples', 'auth.log'),
    url: 'http://ingest.test',
    key: 'k-123',
    batch: 10,
    stateFile: path.join(dir, 'state.json'),
    fetchImpl,
    say: () => {},
  });

  assert.equal(r.parsed, parsedCount(SAMPLE));
  assert.ok(r.batches >= 2);
  assert.equal(fetchImpl.calls.length, r.batches);
  for (const call of fetchImpl.calls) {
    assert.equal(call.endpoint, 'http://ingest.test/api/log');
    assert.equal(call.headers['x-api-key'], 'k-123');
    assert.match(call.headers['content-type'], /application\/json/);
    assert.ok(call.entries.length <= 10);
    for (const entry of call.entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['action', 'actor', 'meta', 'ts']);
      assert.equal(entry.format, undefined);
      assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(typeof entry.actor, 'string');
      assert.equal(typeof entry.meta, 'object');
    }
  }
  const total = fetchImpl.calls.reduce((n, c) => n + c.entries.length, 0);
  assert.equal(total, r.parsed, 'every parsed line is sent exactly once');
  assert.equal(r.firstSeq, 1001, 'the first receipt sequence is reported');
});

test('shipPass persists the offset, so a second run ships nothing', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${SAMPLE.slice(0, 12).join('\n')}\n`);
  const stateFile = path.join(dir, 'state.json');
  const fetchImpl = fakeIngest();
  const base = { file, url: 'http://ingest.test', key: 'k', format: 'sshd', batch: 5, stateFile, fetchImpl, say: () => {} };

  const r1 = await shipPass(base);
  assert.equal(r1.sent, parsedCount(SAMPLE.slice(0, 12)));
  assert.equal(r1.to, fs.statSync(file).size);

  const saved = readState(stateFile);
  assert.equal(saved.offset, r1.to);
  assert.equal(saved.file, file);
  assert.equal(saved.format, 'sshd');
  assert.equal(saved.sent, r1.sent);

  const callsBefore = fetchImpl.calls.length;
  const r2 = await shipPass(base);
  assert.equal(r2.sent, 0);
  assert.equal(r2.linesRead, 0);
  assert.equal(r2.from, r1.to);
  assert.equal(fetchImpl.calls.length, callsBefore, 'nothing new means no POST at all');
});

test('a grown file ships only the appended lines', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${SAMPLE.slice(0, 6).join('\n')}\n`);
  const stateFile = path.join(dir, 'state.json');
  const fetchImpl = fakeIngest();
  const base = { file, url: 'http://ingest.test', key: 'k', batch: 50, stateFile, fetchImpl, say: () => {} };

  const r1 = await shipPass(base);
  fs.appendFileSync(file, `${SAMPLE.slice(6, 9).join('\n')}\n`);
  const r2 = await shipPass(base);

  assert.equal(r2.from, r1.to);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].entries.length, parsedCount(SAMPLE.slice(6, 9)));
  assert.equal(r2.to, fs.statSync(file).size);

  const actors = fetchImpl.calls[1].entries.map((e) => e.actor);
  assert.deepEqual(
    actors,
    SAMPLE.slice(6, 9).map((l) => parseLine(l)).filter(Boolean).map((e) => e.actor)
  );
});

test('a truncated or rotated file restarts from offset 0 and says so', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${SAMPLE.slice(0, 20).join('\n')}\n`);
  const stateFile = path.join(dir, 'state.json');
  const fetchImpl = fakeIngest();
  const said = [];
  const base = {
    file,
    url: 'http://ingest.test',
    key: 'k',
    batch: 50,
    stateFile,
    fetchImpl,
    say: (l) => said.push(l),
  };

  const r1 = await shipPass(base);
  assert.ok(r1.to > 0);

  // logrotate copytruncate: same path, new, shorter content.
  fs.writeFileSync(file, `${authLine('after-rotation-1')}\n${authLine('after-rotation-2')}\n`);
  const r2 = await shipPass(base);

  assert.equal(r2.rotated, true);
  assert.equal(r2.from, 0);
  assert.equal(r2.sent, 2);
  assert.equal(r2.to, fs.statSync(file).size);
  assert.ok(said.some((l) => /rotated or truncated/.test(l)));
  assert.deepEqual(
    fetchImpl.calls[1].entries.map((e) => e.actor),
    ['after-rotation-1', 'after-rotation-2']
  );
  assert.equal(readState(stateFile).offset, r2.to);
});

test('skipped lines after the last batch are counted and consumed, not re-read forever', async () => {
  const dir = tmp();
  const file = path.join(dir, 'mixed.log');
  fs.writeFileSync(
    file,
    `${authLine('a')}\n${authLine('b')}\n${authLine('c')}\nnot a log line\n-- MARK --\n`
  );
  const stateFile = path.join(dir, 'state.json');
  const fetchImpl = fakeIngest();

  // batch === number of valid lines: the batch flushes before the junk at the end.
  const r = await shipPass({
    file,
    url: 'http://ingest.test',
    key: 'k',
    batch: 3,
    stateFile,
    fetchImpl,
    say: () => {},
  });

  assert.equal(r.parsed, 3);
  assert.equal(r.skipped, 2);
  assert.equal(r.to, fs.statSync(file).size);
  const state = readState(stateFile);
  assert.equal(state.skipped, 2, 'trailing junk is counted in the durable state');
  assert.equal(state.offset, fs.statSync(file).size);

  // A file that is nothing but junk: no POST, but the offset still advances past it.
  const junkFile = path.join(dir, 'junk.log');
  fs.writeFileSync(junkFile, 'junk one\njunk two\njunk three\n');
  const callsBefore = fetchImpl.calls.length;
  const junk = await shipPass({
    file: junkFile,
    url: 'http://ingest.test',
    key: 'k',
    batch: 50,
    stateFile: path.join(dir, 'junk-state.json'),
    fetchImpl,
    say: () => {},
  });
  assert.equal(junk.sent, 0);
  assert.equal(junk.skipped, 3);
  assert.equal(fetchImpl.calls.length, callsBefore, 'all-junk pass makes no network call');
  assert.equal(readState(path.join(dir, 'junk-state.json')).offset, fs.statSync(junkFile).size);
});

test('a state file belonging to another log is reset, counters included', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${authLine('a')}\n${authLine('b')}\n${authLine('c')}\n`);
  const stateFile = path.join(dir, 'shared-state.json');
  writeState(stateFile, {
    file: path.join(dir, 'someone-elses.log'),
    ino: '1',
    offset: 999,
    format: 'nginx',
    sent: 5,
    skipped: 9,
  });

  const fetchImpl = fakeIngest();
  const said = [];
  const r = await shipPass({
    file,
    url: 'http://ingest.test',
    key: 'k',
    batch: 50,
    stateFile,
    fetchImpl,
    say: (l) => said.push(l),
  });

  assert.equal(r.from, 0, 'a foreign offset must not be used');
  assert.equal(r.sent, 3, 'the whole file is shipped');
  assert.ok(said.some((l) => /state was for .*someone-elses\.log/.test(l)));
  const saved = readState(stateFile);
  assert.equal(saved.file, file);
  assert.equal(saved.sent, 3, 'counters restart with the file');
  assert.equal(saved.skipped, 0);
});

test('a failed POST is retried with exponential backoff, then fails loudly without moving the offset', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${SAMPLE.slice(0, 10).join('\n')}\n`);
  const stateFile = path.join(dir, 'state.json');
  const fetchImpl = fakeIngest({ failTimes: 99, failStatus: 503 });
  const delays = [];

  await assert.rejects(
    shipPass({
      file,
      url: 'http://ingest.test',
      key: 'k',
      batch: 50,
      stateFile,
      fetchImpl,
      retries: 3,
      retryBaseMs: 500,
      sleep: async (ms) => delays.push(ms),
      say: () => {},
    }),
    /failed after 3 attempts.*503/s
  );

  assert.equal(fetchImpl.calls.length, 3, 'three attempts, not three retries');
  assert.deepEqual(delays, [500, 1000], 'backoff doubles between attempts');
  const state = readState(stateFile);
  assert.equal(state.offset, 0, 'a failed batch must not be skipped on the next run');
  assert.equal(state.sent, 0);
});

test('a retryable failure followed by success ships normally', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${SAMPLE.slice(0, 4).join('\n')}\n`);
  const fetchImpl = fakeIngest({ failTimes: 1, failStatus: 502 });
  const delays = [];
  const r = await shipPass({
    file,
    url: 'http://ingest.test',
    key: 'k',
    batch: 50,
    stateFile: path.join(dir, 'state.json'),
    fetchImpl,
    sleep: async (ms) => delays.push(ms),
    say: () => {},
  });

  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(delays, [500]);
  assert.equal(r.sent, parsedCount(SAMPLE.slice(0, 4)));
});

test('a bad api key fails immediately instead of hammering the server', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${authLine('a')}\n`);
  const fetchImpl = fakeIngest({ failTimes: 99, failStatus: 401 });

  await assert.rejects(
    shipPass({
      file,
      url: 'http://ingest.test',
      key: 'wrong',
      batch: 10,
      stateFile: path.join(dir, 'state.json'),
      fetchImpl,
      say: () => {},
    }),
    /401.*invalid or missing x-api-key/s
  );
  assert.equal(fetchImpl.calls.length, 1, '401 is permanent: one attempt');
});

test('per-entry rejections are reported but do not stop the pass', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${SAMPLE.slice(0, 6).join('\n')}\n`);
  const fetchImpl = fakeIngest({
    accepted: 4,
    rejected: [{ index: 4, reason: 'entry.action is required' }],
  });
  const said = [];
  const r = await shipPass({
    file,
    url: 'http://ingest.test',
    key: 'k',
    batch: 50,
    stateFile: path.join(dir, 'state.json'),
    fetchImpl,
    say: (l) => said.push(l),
  });

  assert.equal(r.sent, 4);
  assert.equal(r.rejected, 1);
  assert.ok(said.some((l) => /rejected 1 entry/.test(l)));
  assert.equal(r.to, fs.statSync(file).size, 'the batch was answered, so the offset advances');
});

test('a 202 with no receipt body is treated as a failure, not as success', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${authLine('a')}\n`);
  const fetchImpl = async () => ({ ok: true, status: 202, text: async () => '<html>proxy</html>' });

  await assert.rejects(
    shipPass({
      file,
      url: 'http://ingest.test',
      key: 'k',
      batch: 10,
      stateFile: path.join(dir, 'state.json'),
      fetchImpl,
      say: () => {},
    }),
    /no JSON receipt body/
  );
});

test('postEntries sends the documented POST and reads the receipts back', async () => {
  const fetchImpl = fakeIngest({ accepted: 2 });
  const out = await postEntries({
    endpoint: 'http://ingest.test/api/log',
    key: 'k',
    entries: [{ ts: '2026-11-20T02:14:07Z', actor: 'a', action: 'x', meta: {} }, { ts: '2026-11-20T02:14:08Z', actor: 'b', action: 'y', meta: {} }],
    fetchImpl,
  });
  assert.equal(out.status, 202);
  assert.equal(out.accepted, 2);
  assert.equal(out.receipts.length, 2);
  assert.equal(fetchImpl.calls[0].endpoint, 'http://ingest.test/api/log');

  const body = JSON.parse(fetchImpl.calls[0].raw);
  assert.ok(Array.isArray(body.entries));
  assert.equal(body.entries.length, 2);
});

test('isRetryable separates transient statuses from permanent ones', () => {
  assert.equal(isRetryable(500), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(408), true);
  assert.equal(isRetryable(401), false);
  assert.equal(isRetryable(400), false);
  assert.equal(isRetryable(413), false);
  assert.equal(isRetryable(null), true, 'a network error has no status and is worth retrying');
});

// --------------------------------------------------------------------------- real HTTP

test('end to end over real HTTP: the server receives authenticated, parseable entries', async () => {
  const received = [];
  const seenKeys = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seenKeys.push(req.headers['x-api-key']);
      if (req.headers['x-api-key'] !== 'good-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid or missing x-api-key' }));
      }
      const { entries } = JSON.parse(body);
      received.push(...entries);
      const receipts = entries.map((_, i) => ({ seq: 500 + received.length - entries.length + i + 1, chash: 'h' }));
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: entries.length, rejected: [], receipts }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    const dir = tmp();
    const file = path.join(REPO, 'samples', 'auth.log');
    const r = await shipPass({
      file,
      url: base,
      key: 'good-key',
      batch: 25,
      stateFile: path.join(dir, 'state.json'),
      say: () => {},
    });

    assert.equal(r.sent, parsedCount(SAMPLE));
    assert.equal(received.length, r.sent);
    assert.equal(new Set(seenKeys).size, 1);
    assert.equal(seenKeys[0], 'good-key');
    assert.equal(received[0].actor, 'rahul');
    assert.equal(received[0].action, 'ssh login accepted');

    // Wrong key: the real 401 body must surface in the error, and only one attempt is made.
    let attempts = 0;
    await assert.rejects(
      postEntries({
        endpoint: `${base}/api/log`,
        key: 'wrong',
        entries: [{ ts: '2026-11-20T02:14:07Z', actor: 'a', action: 'b', meta: {} }],
        fetchImpl: async (...args) => {
          attempts += 1;
          return fetch(...args);
        },
      }),
      /401.*invalid or missing x-api-key/s
    );
    assert.equal(attempts, 1);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

// --------------------------------------------------------------------------- follow

test('runFollow picks up appended lines, sleeps between polls and flushes the last line on stop', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${authLine('first')}\n`);
  const fetchImpl = fakeIngest();
  const delays = [];
  let polls = 0;

  const r = await runFollow({
    file,
    url: 'http://ingest.test',
    key: 'k',
    batch: 50,
    stateFile: path.join(dir, 'state.json'),
    fetchImpl,
    interval: 1000,
    sleep: async (ms) => {
      delays.push(ms);
      polls += 1;
      if (polls === 1) fs.appendFileSync(file, `${authLine('second')}\n`);
      if (polls === 2) fs.appendFileSync(file, authLine('third-without-newline')); // partial, then Ctrl-C
    },
    stop: () => polls >= 3,
    say: () => {},
  });

  assert.ok(delays.every((ms) => ms === 1000), 'polls every second');
  const actors = fetchImpl.calls.flatMap((c) => c.entries.map((e) => e.actor));
  assert.deepEqual(actors, ['first', 'second', 'third-without-newline']);
  assert.equal(r.totals.sent, 3);
  assert.equal(r.state.offset, fs.statSync(file).size);
  assert.ok(r.passes >= 2);
});

test('runFollow with dry-run never calls fetch and still advances in memory', async () => {
  const dir = tmp();
  const file = path.join(dir, 'auth.log');
  fs.writeFileSync(file, `${authLine('a')}\n`);
  let polls = 0;
  const state = readState(path.join(dir, 'state.json'));

  const r = await runFollow({
    file,
    dryRun: true,
    stateFile: path.join(dir, 'state.json'),
    state,
    batch: 10,
    fetchImpl: () => {
      throw new Error('dry run must not call fetch');
    },
    sleep: async () => {
      polls += 1;
    },
    stop: () => polls >= 2,
    say: () => {},
  });

  assert.equal(r.totals.sent, 1);
  assert.equal(state.offset, fs.statSync(file).size);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

// --------------------------------------------------------------------------- the CLI itself

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO, 'scripts', 'shipper.js'), ...args], {
      cwd: REPO,
      env: { ...process.env, WITNESS_TEST: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the CLI prints a banner with file, format, offset, endpoint and batch', async () => {
  const dir = tmp();
  const { code, stdout } = await runCli([
    '--file',
    path.join(REPO, 'samples', 'auth.log'),
    '--dry-run',
    '--batch',
    '20',
    '--state',
    path.join(dir, 'state.json'),
  ]);

  assert.equal(code, 0);
  assert.match(stdout, /trackfoots shipper/);
  assert.match(stdout, /format\s+sshd \(auto-detected\)/);
  assert.match(stdout, /offset\s+0 \(fresh start\)/);
  assert.match(stdout, /batch\s+20 per POST, follow off/);
  assert.match(stdout, /mode\s+dry run/);
  assert.match(stdout, /^done: 52 entries accepted/m);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('the CLI exits 2 on bad usage and 1 on a missing file', async () => {
  const bad = await runCli(['--file', 'x.log']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--url is required/);
  assert.match(bad.stderr, /usage: node scripts\/shipper\.js/);

  const missing = await runCli(['--file', path.join(tmp(), 'nope.log'), '--dry-run']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no such log file/);
});

test('USAGE documents every documented flag', () => {
  for (const flag of ['--file', '--url', '--key', '--follow', '--format', '--batch', '--state', '--dry-run', '--help']) {
    assert.ok(USAGE.includes(flag), `usage should mention ${flag}`);
  }
  assert.match(USAGE, /exit codes/);
});

test('formatBanner is compact and names every field an operator needs', () => {
  const text = formatBanner({
    file: '/var/log/auth.log',
    format: 'sshd',
    formatSource: 'auto-detected',
    offset: 4096,
    endpoint: 'http://localhost:5173/api/log',
    batch: 50,
    follow: true,
    stateFile: '/var/log/.shipper-state.json',
    dryRun: false,
  });
  assert.equal(text.split('\n').length, 7);
  for (const needle of ['file', '/var/log/auth.log', 'format', 'sshd', 'offset', '4096 (resuming)', 'endpoint', 'http://localhost:5173/api/log', 'batch', '50 per POST', 'follow on']) {
    assert.ok(text.includes(needle), `banner should include ${needle}`);
  }
  assert.ok(!text.includes('dry run'));
});
