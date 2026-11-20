'use strict';
/**
 * formats.js — real log lines in, chain entries out.
 *
 * Every parser takes one raw line and returns { ts, actor, action, meta } or null
 * for a line it cannot read. `ts` is always an ISO-8601 string; when the source
 * line carried a UTC offset (nginx writes "+0530") the ISO string keeps that
 * offset instead of quietly rebasing the event to UTC — the entry should say what
 * the server said.
 *
 * Lines that arrive without a timestamp are refused rather than stamped with
 * "now": inventing a time is exactly the kind of drift this product exists to
 * catch. A real auth.log/syslog line always carries its own timestamp.
 */

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Drop empty fields so meta stays readable in the UI. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** '+0530' | '+05:30' | 'Z' -> '+05:30' | 'Z'; anything else -> null. */
function normalizeOffset(token) {
  if (!token) return null;
  const t = String(token).trim();
  if (/^z$/i.test(t)) return 'Z';
  const m = t.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return null;
  const off = `${m[1]}${pad(hh)}:${pad(mm)}`;
  return off === '+00:00' || off === '-00:00' ? 'Z' : off;
}

/**
 * Assemble + validate an ISO string from numeric parts.
 * Returns null for impossible values (Feb 31, minute 99, hour 24) so a corrupt
 * line is skipped instead of landing in the log as a bogus time.
 */
function isoFromParts({ year, month, day, hour, minute, second, ms, offset }) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 0 || month > 11) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  if (!Number.isInteger(hour) || hour > 23) return null;
  if (!Number.isInteger(minute) || minute > 59) return null;
  if (!Number.isInteger(second) || second > 60) return null;

  const frac = ms === undefined || ms === null ? '' : `.${String(ms).slice(0, 3).padEnd(3, '0')}`;
  const iso = `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${frac}${offset || 'Z'}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** rsyslog's modern prefix: 2026-11-20T02:14:07.123456+05:30 web-01 sshd[2201]: ... */
const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+(\S+)\s+([A-Za-z0-9_./-]+)(?:\[(\d+)\])?:\s?([\s\S]*)$/;

/** RFC 3164: Nov 20 02:14:07 web-01 systemd[1]: Started Session 12 of user rahul. */
const RFC3164 = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+([A-Za-z0-9_./-]+)(?:\[(\d+)\])?:\s?([\s\S]*)$/;

/**
 * Split the syslog envelope off a line. Both timestamp shapes are supported:
 * RFC 3164 (no year, no offset — the classic /var/log/auth.log) and the ISO
 * prefix rsyslog/modern journald forwarders emit.
 */
function splitPrefix(line, opts = {}) {
  let m = line.match(ISO_PREFIX);
  if (m) {
    return {
      ts: m[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2'),
      host: m[2],
      program: m[3],
      pid: m[4] ? Number(m[4]) : null,
      message: m[5],
    };
  }

  m = line.match(RFC3164);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (month === undefined) return null;
  const year = Number.isInteger(opts.year) ? opts.year : new Date().getFullYear();
  const ts = isoFromParts({
    year,
    month,
    day: Number(m[2]),
    hour: Number(m[3]),
    minute: Number(m[4]),
    second: Number(m[5]),
    offset: null,
  });
  if (!ts) return null;
  return {
    ts,
    host: m[6],
    program: m[7],
    pid: m[8] ? Number(m[8]) : null,
    message: m[9],
  };
}

const SSH_ACCEPTED = /^Accepted (\S+) for (\S+) from (\S+) port (\d+)(?: (ssh[\d.]*))?/;
const SSH_FAILED = /^Failed (\S+) for (invalid user )?(\S+) from (\S+) port (\d+)(?: (ssh[\d.]*))?/;
const SSH_INVALID_USER = /^Invalid user (\S+)(?: from (\S+))?(?: port (\d+))?/;
const SSH_SESSION = /session (opened|closed) for user (\S+?)(?:\s+by\s+(.+?))?$/;
const SSH_CONN_CLOSED = /^Connection closed by (?:authenticating |invalid )?user (\S+) (\S+) port (\d+)/;
const SSH_MAX_AUTH = /^error: maximum authentication attempts exceeded for (\S+) from (\S+) port (\d+)/;
const SSH_DISCONNECT = /^Disconnecting (?:authenticating |invalid )?user (\S+) (\S+) port (\d+): (.*)$/;

/** `rahul : TTY=pts/0 ; PWD=/home/rahul ; USER=root ; COMMAND=/bin/cat /etc/passwd` */
function parseSudoPayload(prefix, message) {
  const m = message.match(/^(.+?)\s*:\s*([\s\S]*)$/);
  if (!m) return null;
  const actor = m[1].trim();
  if (!/^[A-Za-z0-9_.@-]+$/.test(actor)) return null;

  const fields = {};
  for (const part of m[2].split(';')) {
    const kv = part.trim().match(/^([A-Za-z_]+)=(.*?)\s*$/);
    if (kv) fields[kv[1].toUpperCase()] = kv[2];
    else if (/incorrect password attempts?/i.test(part)) fields.ATTEMPTS = part.trim();
  }
  if (!fields.COMMAND && !fields.TTY && !fields.ATTEMPTS) return null;

  const action = fields.COMMAND
    ? `sudo ${fields.COMMAND}`
    : fields.ATTEMPTS
      ? 'sudo authentication failed'
      : 'sudo session';

  return {
    ts: prefix.ts,
    actor,
    action,
    meta: compact({
      host: prefix.host,
      pid: prefix.pid,
      tty: fields.TTY,
      pwd: fields.PWD,
      user: fields.USER,
      command: fields.COMMAND,
      attempts: fields.ATTEMPTS,
    }),
  };
}

/**
 * OpenSSH / sudo lines. The message grammar is the two systems' own, so a line
 * whose payload we do not recognise returns null instead of a vague "something
 * happened" entry.
 */
function parseSshd(line, opts = {}) {
  if (typeof line !== 'string') return null;
  const prefix = splitPrefix(line.trim(), opts);
  if (!prefix) return null;

  const program = prefix.program.replace(/\d+$/, '');
  if (/^sudo/.test(program)) return parseSudoPayload(prefix, prefix.message);
  if (!/^sshd(-session)?$/.test(program)) return null;

  const msg = prefix.message;
  const base = { host: prefix.host, pid: prefix.pid };

  let m = msg.match(SSH_ACCEPTED);
  if (m) {
    return {
      ts: prefix.ts,
      actor: m[2],
      action: 'ssh login accepted',
      meta: compact({ ...base, ip: m[3], port: Number(m[4]), method: m[1], protocol: m[5] }),
    };
  }

  m = msg.match(SSH_FAILED);
  if (m) {
    const invalid = Boolean(m[2]);
    return {
      ts: prefix.ts,
      actor: m[3],
      action: 'ssh login failed',
      meta: compact({
        ...base,
        ip: m[4],
        port: Number(m[5]),
        method: m[1],
        protocol: m[6],
        invalidUser: invalid ? true : undefined,
      }),
    };
  }

  m = msg.match(SSH_INVALID_USER);
  if (m) {
    return {
      ts: prefix.ts,
      actor: m[1],
      action: 'ssh invalid user',
      meta: compact({ ...base, ip: m[2], port: m[3] ? Number(m[3]) : undefined }),
    };
  }

  m = msg.match(SSH_SESSION);
  if (m) {
    const who = m[2].replace(/\(uid=\d+\)$/, '');
    return {
      ts: prefix.ts,
      actor: who,
      action: `ssh session ${m[1]}`,
      meta: compact({ ...base, by: m[3] }),
    };
  }

  m = msg.match(SSH_CONN_CLOSED);
  if (m) {
    return {
      ts: prefix.ts,
      actor: m[1],
      action: 'ssh connection closed',
      meta: compact({ ...base, ip: m[2], port: Number(m[3]) }),
    };
  }

  m = msg.match(SSH_MAX_AUTH);
  if (m) {
    return {
      ts: prefix.ts,
      actor: m[1],
      action: 'ssh auth attempts exceeded',
      meta: compact({ ...base, ip: m[2], port: Number(m[3]) }),
    };
  }

  m = msg.match(SSH_DISCONNECT);
  if (m) {
    return {
      ts: prefix.ts,
      actor: m[1],
      action: 'ssh disconnected',
      meta: compact({ ...base, ip: m[2], port: Number(m[3]), reason: m[4] }),
    };
  }

  return null;
}

/** nginx/apache combined + common log format. */
const NGINX = /^(\S+)\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+(\d+|-)(?:\s+"([^"]*)"\s+"([^"]*)")?(?:\s+"([^"]*)")?/;
const NGINX_TIME = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-]\d{4}|Z))?$/;

function looksLikeIp(ip) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip.split('.').every((oct) => Number(oct) <= 255);
  }
  return /^[0-9a-f:]+$/i.test(ip) && ip.includes(':');
}

/** 20/Nov/2026:02:14:07 +0530 -> 2026-11-20T02:14:07+05:30 */
function parseNginxTime(token) {
  const m = token.trim().match(NGINX_TIME);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (month === undefined) return null;
  return isoFromParts({
    year: Number(m[3]),
    month,
    day: Number(m[1]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
    offset: normalizeOffset(m[7]),
  });
}

function parseNginx(line) {
  if (typeof line !== 'string') return null;
  const m = line.trim().match(NGINX);
  if (!m) return null;

  const [, ip, , user, time, request, status, bytes, referer, ua] = m;
  if (!looksLikeIp(ip)) return null;

  const ts = parseNginxTime(time);
  if (!ts) return null;

  const req = request.match(/^([A-Z]+) (\S+)(?: (\S+))?$/);
  if (!req && request !== '-') return null; // malformed request line: do not invent a method
  const method = req ? req[1] : '-';
  const target = req ? req[2] : '-';
  const protocol = req ? req[3] : undefined;

  return {
    ts,
    actor: user && user !== '-' ? user : '-',
    action: `${method} ${target} ${status}`,
    meta: compact({
      ip,
      status: Number(status),
      bytes: bytes === '-' ? 0 : Number(bytes),
      protocol,
      referer: referer && referer !== '-' ? referer : undefined,
      ua: ua && ua !== '-' ? ua : undefined,
    }),
  };
}

/** Generic RFC 3164 / ISO-prefixed syslog line. */
function parseSyslog(line, opts = {}) {
  if (typeof line !== 'string') return null;
  const prefix = splitPrefix(line.trim(), opts);
  if (!prefix) return null;

  const message = prefix.message.trim();
  if (!message) return null;

  // sshd/sudo talk their own grammar above. If that parser rejected the payload,
  // the line is corrupt (truncated write, bad rotation) — record it as skipped
  // rather than as a vague "something happened" entry.
  if (/^(sshd(-session)?|sudo)$/.test(prefix.program.replace(/\d+$/, ''))) return null;

  const who = message.match(/\b(?:user|for) ([A-Za-z0-9_.@-]+)/);
  return {
    ts: prefix.ts,
    actor: who ? who[1].replace(/[.,;:]+$/, '') : prefix.host,
    action: message,
    meta: compact({ host: prefix.host, program: prefix.program, pid: prefix.pid }),
  };
}

const PARSERS = [
  ['sshd', parseSshd],
  ['nginx', parseNginx],
  ['syslog', parseSyslog],
];

/** First parser that accepts the line, tagged with the format that matched. */
function parseLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim();
  if (!s) return null;
  for (const [format, parse] of PARSERS) {
    const hit = parse(s);
    if (hit) return { ...hit, format };
  }
  return null;
}

/**
 * Plurality vote over a sample of the file. Junk lines simply do not vote, so a
 * file with a few rotated/spliced lines still gets identified correctly.
 */
function detectFormat(lines, opts = {}) {
  const sampleCap = Number.isInteger(opts.sample) ? opts.sample : 200;
  const votes = { sshd: 0, nginx: 0, syslog: 0 };
  let considered = 0;

  for (const line of lines || []) {
    if (typeof line !== 'string') continue;
    if (!line.trim()) continue;
    if (considered >= sampleCap) break;
    considered += 1;
    const hit = parseLine(line);
    if (hit) votes[hit.format] += 1;
  }

  let winner = 'unknown';
  let best = 0;
  for (const [format, count] of Object.entries(votes)) {
    if (count > best) {
      best = count;
      winner = format;
    }
  }
  return best > 0 ? winner : 'unknown';
}

module.exports = {
  parseSshd,
  parseNginx,
  parseSyslog,
  parseLine,
  detectFormat,
  normalizeOffset,
  isoFromParts,
};
