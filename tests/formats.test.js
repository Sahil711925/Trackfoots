'use strict';
/**
 * formats.test.js — the parsers, the format vote, and a real import end to end.
 * Everything runs against a temp WITNESS_DATA; data/ is never touched.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const DATA = path.join(os.tmpdir(), `witness-test-formats-${process.pid}-${Date.now()}`);
process.env.WITNESS_DATA = DATA;
process.env.WITNESS_TEST = '1';
process.env.ANCHOR_ON_CHAIN = 'false';
process.env.BATCH_SIZE = '100';

const REPO = path.resolve(__dirname, '..');
const { parseSshd, parseNginx, parseSyslog, parseLine, detectFormat } = require(path.join(REPO, 'lib', 'formats.js'));
const store = require(path.join(REPO, 'lib', 'store.js'));
const { importFile, parseArgs, formatSummary } = require(path.join(REPO, 'scripts', 'import-logs.js'));

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const sample = (name) => fs.readFileSync(path.join(REPO, 'samples', name), 'utf8').split('\n').filter(Boolean);
const okEntries = () => store.readLogs().filter((r) => r.ok).map((r) => r.entry);

const AUTH = 'Nov 20 02:14:07 web-01 sshd[2201]: Accepted publickey for rahul from 103.21.44.9 port 51234 ssh2: RSA SHA256:q3rT9x';
const ACCESS = '103.21.44.9 - - [20/Nov/2026:02:14:07 +0530] "GET /api/orders HTTP/1.1" 200 512 "-" "curl/8.4.0"';
const SYSLOG = 'Nov 20 02:14:07 web-01 systemd[1]: Started Session 12 of user rahul.';
const SUDO = 'Nov 20 02:14:12 web-01 sudo: rahul : TTY=pts/0 ; PWD=/home/rahul ; USER=root ; COMMAND=/bin/cat /etc/passwd';

// ---------------------------------------------------------------- sshd

test('parseSshd reads an OpenSSH "Accepted publickey" line', () => {
  const e = parseSshd(AUTH, { year: 2026 });
  assert.ok(e, 'expected a parse');
  assert.equal(e.ts, '2026-11-20T02:14:07Z');
  assert.match(e.ts, ISO);
  assert.equal(e.actor, 'rahul');
  assert.equal(e.action, 'ssh login accepted');
  assert.equal(e.meta.ip, '103.21.44.9');
  assert.equal(e.meta.port, 51234);
  assert.equal(e.meta.method, 'publickey');
  assert.equal(e.meta.protocol, 'ssh2');
  assert.equal(e.meta.pid, 2201);
});

test('parseSshd reads failed logins, including invalid users', () => {
  const failed = parseSshd('Nov 20 02:15:44 web-01 sshd[2214]: Failed password for vikram from 103.21.44.27 port 49212 ssh2', { year: 2026 });
  assert.equal(failed.action, 'ssh login failed');
  assert.equal(failed.actor, 'vikram');
  assert.equal(failed.meta.method, 'password');
  assert.equal(failed.meta.invalidUser, undefined);

  const invalid = parseSshd('Nov 20 02:16:31 web-01 sshd[2219]: Failed password for invalid user admin from 45.33.12.7 port 40022 ssh2', { year: 2026 });
  assert.equal(invalid.actor, 'admin');
  assert.equal(invalid.action, 'ssh login failed');
  assert.equal(invalid.meta.invalidUser, true);
  assert.equal(invalid.meta.ip, '45.33.12.7');

  const probe = parseSshd('Nov 20 02:16:31 web-01 sshd[2219]: Invalid user oracle from 45.33.12.7 port 40026', { year: 2026 });
  assert.equal(probe.action, 'ssh invalid user');
  assert.equal(probe.actor, 'oracle');
  assert.equal(probe.meta.port, 40026);
});

test('parseSshd reads session opened/closed and sudo escalations', () => {
  const opened = parseSshd('Nov 20 02:15:03 web-01 sshd[2210]: pam_unix(sshd:session): session opened for user priya by priya(uid=0)', { year: 2026 });
  assert.equal(opened.action, 'ssh session opened');
  assert.equal(opened.actor, 'priya');
  assert.equal(opened.meta.by, 'priya(uid=0)');

  const closed = parseSshd('Nov 20 02:17:41 web-01 sshd[2231]: pam_unix(sshd:session): session closed for user karthik', { year: 2026 });
  assert.equal(closed.action, 'ssh session closed');
  assert.equal(closed.actor, 'karthik');

  const sudo = parseSshd(SUDO, { year: 2026 });
  assert.equal(sudo.actor, 'rahul');
  assert.equal(sudo.action, 'sudo /bin/cat /etc/passwd');
  assert.equal(sudo.meta.command, '/bin/cat /etc/passwd');
  assert.equal(sudo.meta.user, 'root');
  assert.equal(sudo.meta.tty, 'pts/0');
  assert.equal(sudo.meta.pwd, '/home/rahul');
});

test('parseSshd rejects junk, non-sshd programs and lines with no timestamp', () => {
  assert.equal(parseSshd('this is not a log line'), null);
  assert.equal(parseSshd(''), null);
  assert.equal(parseSshd('not a string'), null);
  assert.equal(parseSshd('-- MARK --'), null);
  assert.equal(parseSshd('Nov 20 02:99:01 web-01 sshd[2201]: session opened for user rahul'), null, 'minute 99 is not a time');
  assert.equal(parseSshd('Nov 20 02:14:07 web-01 sshd[2201]: Accepted publickey for '), null, 'truncated payload');
  assert.equal(parseSshd('Nov 20 02:14:07 web-01 systemd[1]: Started Session 12 of user rahul.'), null, 'systemd is not sshd');
  assert.equal(parseSshd(ACCESS), null, 'an nginx line is not an sshd line');
  assert.equal(parseSshd('Accepted publickey for rahul from 103.21.44.9 port 51234 ssh2'), null, 'no timestamp to record');
});

// ---------------------------------------------------------------- nginx

test('parseNginx reads a combined-format line and keeps the +0530 offset', () => {
  const e = parseNginx(ACCESS);
  assert.ok(e);
  assert.equal(e.ts, '2026-11-20T02:14:07+05:30');
  assert.match(e.ts, ISO);
  assert.equal(new Date(e.ts).toISOString(), '2026-11-19T20:44:07.000Z', 'same instant, not the same wall clock');
  assert.equal(e.actor, '-');
  assert.equal(e.action, 'GET /api/orders 200');
  assert.equal(e.meta.ip, '103.21.44.9');
  assert.equal(e.meta.status, 200);
  assert.equal(e.meta.bytes, 512);
});

test('parseNginx uses the authenticated user when the field is present, and handles "-" bytes', () => {
  const e = parseNginx('103.21.44.88 - rahul [20/Nov/2026:02:15:29 +0530] "POST /api/orders HTTP/1.1" 201 351 "https://app.trackfoots.dev/orders/new" "Mozilla/5.0"');
  assert.equal(e.actor, 'rahul');
  assert.equal(e.action, 'POST /api/orders 201');
  assert.equal(e.meta.status, 201);

  const noBytes = parseNginx('103.21.44.120 - - [20/Nov/2026:02:17:41 +0530] "GET /static/app.js HTTP/1.1" 304 - "-" "Mozilla/5.0"');
  assert.equal(noBytes.meta.bytes, 0);
  assert.equal(noBytes.action, 'GET /static/app.js 304');
});

test('parseNginx rejects junk, truncated lines, sshd lines and impossible times', () => {
  assert.equal(parseNginx('this is not a log line'), null);
  assert.equal(parseNginx('<html><body><h1>502 Bad Gateway</h1></body></html>'), null);
  assert.equal(parseNginx('103.21.44.9 - - [20/Nov/2026:02:14:0'), null, 'truncated mid-timestamp');
  assert.equal(parseNginx('999.21.44.9 - - [20/Nov/2026:02:14:07 +0530] "GET / HTTP/1.1" 200 12'), null, 'octet out of range');
  assert.equal(parseNginx('1.2.3.4 - - [20/Foo/2026:02:14:07 +0530] "GET / HTTP/1.1" 200 12'), null, 'unknown month');
  assert.equal(parseNginx('1.2.3.4 - - [20/Nov/2026:02:14:07 +0530] " GET / HTTP/1.1" 200 12'), null, 'garbled request');
  assert.equal(parseNginx(AUTH), null, 'an sshd line is not an nginx line');
  assert.equal(parseNginx(SYSLOG), null);
});

// ---------------------------------------------------------------- syslog

test('parseSyslog reads an RFC 3164 line', () => {
  const e = parseSyslog(SYSLOG, { year: 2026 });
  assert.ok(e);
  assert.equal(e.ts, '2026-11-20T02:14:07Z');
  assert.match(e.ts, ISO);
  assert.equal(e.actor, 'rahul', 'the actor is the named user, not the host');
  assert.equal(e.action, 'Started Session 12 of user rahul.');
  assert.equal(e.meta.host, 'web-01');
  assert.equal(e.meta.program, 'systemd');
  assert.equal(e.meta.pid, 1);
});

test('parseSyslog falls back to the host when no user is named, and reads ISO-prefixed lines', () => {
  const cron = parseSyslog('Nov 20 02:14:12 web-01 CRON[2205]: (root) CMD (/usr/local/bin/backup-orders.sh)', { year: 2026 });
  assert.equal(cron.actor, 'web-01');
  assert.equal(cron.meta.program, 'CRON');

  const iso = parseSyslog('2026-11-20T02:14:07.123456+05:30 web-01 kernel: EXT4-fs (sda1): mounted filesystem');
  assert.equal(iso.ts, '2026-11-20T02:14:07.123456+05:30', 'source precision and offset are preserved');
  assert.ok(!Number.isNaN(Date.parse(iso.ts)));
  assert.equal(iso.meta.program, 'kernel');
});

test('parseSyslog rejects junk, bad times and unclassified sshd payloads', () => {
  assert.equal(parseSyslog(''), null);
  assert.equal(parseSyslog('not a log line at all'), null);
  assert.equal(parseSyslog('[ 1203.559112] audit: type=1400 apparmor="DENIED"'), null, 'no syslog envelope');
  assert.equal(parseSyslog('Nov 02:31:14 web-01 systemd[1]: Clock skew detected'), null, 'no day field');
  assert.equal(parseSyslog('Nov 20 02:99:00 web-01 kernel: truncated'), null);
  assert.equal(parseSyslog('Nov 20 02:14:07 web-01 sshd[1]: Accepted publickey for '), null, 'sshd payloads belong to parseSshd');
});

// ---------------------------------------------------------------- dispatch

test('parseLine tags the line with the format that matched', () => {
  assert.equal(parseLine(AUTH).format, 'sshd');
  assert.equal(parseLine(SUDO).format, 'sshd');
  assert.equal(parseLine(ACCESS).format, 'nginx');
  assert.equal(parseLine(SYSLOG).format, 'syslog');
  assert.equal(parseLine('-- MARK --'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine(null), null);
});

test('parseLine never leaks the format tag into hashed fields', () => {
  const e = parseLine(ACCESS);
  const { format, ...rest } = e;
  assert.equal(format, 'nginx');
  assert.deepEqual(Object.keys(rest).sort(), ['action', 'actor', 'meta', 'ts']);
});

test('detectFormat votes on the sample files and says unknown for junk', () => {
  assert.equal(detectFormat(sample('auth.log')), 'sshd');
  assert.equal(detectFormat(sample('access.log')), 'nginx');
  assert.equal(detectFormat(sample('syslog.log')), 'syslog');
  assert.equal(detectFormat(['junk', '', 'more junk']), 'unknown');
  assert.equal(detectFormat([]), 'unknown');
});

// ---------------------------------------------------------------- samples

test('sample files exist in the real shapes and exercise the skip path', () => {
  for (const [name, format, minLines, maxLines] of [
    ['auth.log', 'sshd', 30, 60],
    ['access.log', 'nginx', 30, 60],
    ['syslog.log', 'syslog', 30, 60],
  ]) {
    const lines = sample(name);
    assert.ok(lines.length >= minLines && lines.length <= maxLines, `${name} has ${lines.length} lines`);
    assert.equal(detectFormat(lines), format, `${name} format`);

    const parsed = lines.map((l) => parseLine(l)).filter(Boolean);
    assert.ok(parsed.length >= minLines - 5, `${name} should parse most lines, got ${parsed.length}`);
    assert.ok(parsed.length < lines.length, `${name} must contain deliberately unparseable lines`);

    for (const e of parsed) {
      assert.match(e.ts, ISO, `${name}: ${e.ts}`);
      assert.ok(!Number.isNaN(Date.parse(e.ts)));
      assert.ok(e.actor && typeof e.actor === 'string');
      assert.ok(e.action && typeof e.action === 'string');
      assert.equal(typeof e.meta, 'object');
    }
  }
});

// ---------------------------------------------------------------- import

test('importFile --dry-run parses without writing anything', () => {
  const before = okEntries().length;
  const r = importFile({ file: path.join(REPO, 'samples', 'auth.log'), dryRun: true });

  assert.equal(r.dryRun, true);
  assert.equal(r.format, 'sshd');
  assert.equal(r.written, 0);
  assert.equal(okEntries().length, before, 'dry run must not touch the log');
  assert.equal(r.parsed + r.skipped, r.linesRead);
  assert.ok(r.parsed > r.skipped);
  assert.match(r.firstTs, ISO);
  assert.match(r.lastTs, ISO);
});

test('importFile honours --max by lines read', () => {
  const r = importFile({ file: path.join(REPO, 'samples', 'access.log'), max: 10, dryRun: true });
  assert.equal(r.linesRead, 10);
  assert.equal(r.parsed + r.skipped, 10);
  assert.equal(r.max, 10);
  assert.equal(r.entries.length, r.parsed);
});

test('importFile writes parsed entries through the store and they round-trip', () => {
  const before = okEntries().length;
  const r = importFile({ file: path.join(REPO, 'samples', 'auth.log') });

  assert.equal(r.written, r.parsed);
  assert.ok(r.written > 30);

  const entries = okEntries();
  assert.equal(entries.length, before + r.written);
  assert.ok(store.LOGS.startsWith(DATA), 'import must write under the test data dir');

  const imported = entries.slice(before);
  for (let i = 0; i < imported.length; i += 1) {
    const got = imported[i];
    const want = r.entries[i];
    assert.equal(got.ts, want.ts);
    assert.equal(got.actor, want.actor);
    assert.equal(got.action, want.action);
    assert.deepEqual(got.meta, want.meta);
    assert.equal(got.format, undefined, 'format is parser metadata, not part of the entry');
    assert.equal(got.seq, before + i + 1);
    assert.equal(got.hash, store.entryDigest(got, got.prevHash));
  }
  assert.equal(imported[0].prevHash, before === 0 ? 'GENESIS' : entries[before - 1].hash);
  assert.equal(store.readReceipts().length, entries.length, 'receipts are mirrored for imported entries');
});

test('importFile writes nothing when every line is junk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-junk-'));
  const file = path.join(dir, 'junk.log');
  fs.writeFileSync(file, 'not a log\n-- MARK --\n^@^@^@ broken\n');

  const before = okEntries().length;
  const r = importFile({ file });
  assert.equal(r.format, 'unknown');
  assert.equal(r.parsed, 0);
  assert.equal(r.skipped, 3);
  assert.equal(r.written, 0);
  assert.equal(okEntries().length, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('importFile fails loudly on a missing file', () => {
  assert.throws(() => importFile({ file: path.join(REPO, 'samples', 'nope.log') }), /no such log file/);
  assert.throws(() => importFile({}), /requires a path/);
});

test('the CLI summary reports file, format, counts and timestamps', () => {
  const r = importFile({ file: path.join(REPO, 'samples', 'syslog.log'), max: 5, dryRun: true });
  const text = formatSummary(r);
  for (const needle of ['file', 'format', 'syslog', 'lines read', 'parsed', 'skipped', 'first timestamp', 'last timestamp', 'dry run']) {
    assert.ok(text.includes(needle), `summary should mention ${needle}`);
  }
});

test('CLI flags are parsed and bad values are refused', () => {
  assert.deepEqual(parseArgs(['samples/auth.log', '--max', '10', '--dry-run']), { file: 'samples/auth.log', max: 10, dryRun: true, help: false });
  assert.equal(parseArgs(['--max=7', 'a.log']).max, 7);
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['a.log', '--max', '0']), /positive integer/);
  assert.throws(() => parseArgs(['a.log', '--max']), /positive integer/);
  assert.throws(() => parseArgs(['a.log', '--bogus']), /unknown flag/);
  assert.throws(() => parseArgs(['a.log', 'b.log']), /one file at a time/);
});
