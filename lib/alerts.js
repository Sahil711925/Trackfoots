'use strict';
/**
 * alerts.js — somebody has to be told.
 *
 * A detection that nobody hears about is a log line, not a control. Every tamper event and
 * every liveness failure writes an alert record, and optionally POSTs it to a webhook
 * (Slack, PagerDuty, an ops mailbox — whatever ALERT_WEBHOOK points at).
 *
 * Deliberately simple: no queueing, no retries, no dedupe beyond a one-per-minute guard.
 * The point is that the path exists and is visible in the UI, not that it survives a network
 * partition.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = () => path.join(store.DATA, 'alerts.log');
const REPEAT_GUARD_MS = 60_000;
let lastSent = { type: null, at: 0 };

function ensure() {
  store.ensure();
}

function recent(limit = 20) {
  const file = FILE();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .slice(-limit)
    .reverse();
}

/**
 * Raise an alert. Repeats of the same type inside a minute are recorded but not re-dispatched,
 * so a polling UI cannot turn one incident into a hundred pages.
 */
function raise(type, message, detail = {}) {
  ensure();
  const now = Date.now();
  const duplicate = lastSent.type === type && now - lastSent.at < REPEAT_GUARD_MS;
  const record = {
    ts: new Date(now).toISOString(),
    type,
    message,
    severity: detail.severity || 'high',
    dispatched: !duplicate,
    detail,
  };

  fs.appendFileSync(FILE(), JSON.stringify(record) + '\n');

  if (!duplicate) {
    lastSent = { type, at: now };
    const hook = process.env.ALERT_WEBHOOK;
    if (hook) {
      // fire and forget: never let a slow webhook block a log write
      fetch(hook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `[Trackfoots] ${type}: ${message}`, ...record }),
      }).catch(() => {});
    } else {
      process.stderr.write(`\n  ALERT  ${type}: ${message}\n`);
    }
  }

  return record;
}

module.exports = { raise, recent, FILE };
