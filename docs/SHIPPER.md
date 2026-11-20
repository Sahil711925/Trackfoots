# The log shipper

`scripts/shipper.js` is the adoption path: an operator points it at a log file they already
have, and the log starts appearing in Trackfoots with a signed receipt per line. No application
change, no agent to install, no code to link.

```bash
node scripts/shipper.js \
  --file /var/log/auth.log \
  --url https://logs.example.com \
  --key "$INGEST_KEY" \
  --follow
```

```
trackfoots shipper
  file      /var/log/auth.log
  format    sshd (auto-detected)
  offset    0 (fresh start)
  endpoint  https://logs.example.com/api/log
  batch     50 per POST, follow off
  state     /var/log/.shipper-state.json
sent 50 entries -> 202 accepted 50; receipts 50, first seq 1
sent 2 entries -> 202 accepted 2; receipts 2, first seq 51
done: 52 entries accepted, 4 lines skipped, 2 batches, offset 0 -> 5711, first seq 1, last seq 52
```

The server prints the same receipt sequence numbers it returns to any other ingest client, so
the operator can check the first and last sequence of each batch against `GET /api/stats`.

## Requirements

- Node 22 or newer (uses global `fetch`; developed on Node 26).
- The server must have `INGEST_KEY` set — without it `POST /api/log` answers `503`.
- Read access to the log file, write access to the directory it lives in (for the state file).

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--file <path>` | required | Log file: OpenSSH `auth.log`, nginx/apache combined `access.log`, or RFC 3164 / ISO-prefixed syslog. |
| `--url <base-url>` | required¹ | Base URL (`http://host:port`) or the endpoint itself; `/api/log` is appended when absent. |
| `--key <api-key>` | required¹ | Sent as `x-api-key`. Must equal the server's `INGEST_KEY`. |
| `--follow`, `-f` | off | Keep tailing: poll every 1000 ms until Ctrl-C. |
| `--format <name>` | `auto` | `auto`, `sshd`, `nginx` or `syslog`. `auto` accepts any line the parser understands; an explicit format skips lines belonging to another grammar. |
| `--batch <n>` | `50` | Entries per POST. Capped at 1000, the server's `maxBatch`. |
| `--state <file>` | `.shipper-state.json` next to the log | Resume offset and counters. |
| `--dry-run` | off | Parse and report; no network, no state file written. |
| `--help`, `-h` | | Usage. |

¹ optional with `--dry-run`, which never sends anything.

## What gets shipped

Lines are parsed by `lib/formats.js` — the same parser `scripts/import-logs.js` and the demo
seeder use. There is no second grammar in the shipper, so a line the importer accepts is a line
the shipper accepts, and vice versa.

Each accepted line becomes `{ ts, actor, action, meta }` and is sent as one entry in
`POST /api/log` with `{"entries": [...]}`. The parser's `format` tag is **not** included: the
entry contains only what gets hashed.

Lines the parser refuses are counted and skipped, never guessed at:

```
done: 52 entries accepted, 4 lines skipped, 2 batches, offset 0 -> 5711
```

That is the right behaviour for the product: a half-written or corrupt line gets no invented
timestamp and no vague "something happened" entry. If skipped counts look wrong for a file,
run `--dry-run --format auto` and check the format in the banner.

RFC 3164 lines (`Nov 20 02:14:07 host prog: ...`) carry no year. The parser uses the current
year, exactly as the importer does; a file spanning New Year should be shipped as it rolls over.

## Resume, truncation and rotation

The state file stores a **byte offset** — the byte immediately after the last line the server
accepted — plus the file path, the inode and running counters:

```json
{
  "version": 1,
  "file": "/var/log/auth.log",
  "ino": "6473924464498331",
  "offset": 5711,
  "format": "sshd",
  "sent": 52,
  "skipped": 4,
  "updatedAt": "2026-11-20T16:49:53.268Z"
}
```

Three cases, all handled:

| Situation | Behaviour |
| --- | --- |
| Restart, file unchanged | Banner shows `offset 5711 (resuming)`, nothing is re-sent. |
| File grew | Reads from the stored offset and ships only the new lines. |
| Truncated / copied over (`copytruncate`, `> file`) | `size < offset` → restart from 0 and print `log rotated or truncated … restarting from offset 0`. |
| Replaced by rename (`mv new old`) | Different inode at the same path → same restart-from-0 path. If the filesystem reports no inode, the size check still catches the usual smaller-file case. |
| State file deleted | Treated as a fresh start: the whole file is shipped again (duplicates, not data loss). |

A line without its trailing newline is **not** consumed while following — the writer may still
be mid-line. In one-shot mode, and in the final flush after Ctrl-C, that last line is complete
as far as the shipper is concerned and is shipped.

The state write is write-then-rename, so a crash during the write cannot leave a half-written
offset behind. A corrupt state file is reported and treated as offset 0 rather than trusted.

## Delivery guarantees

At-least-once, per batch:

- The offset only moves after the server answered `2xx` **for that batch**, so a batch is never
  skipped because of a network failure.
- A crash between the server accepting a batch and the state write can re-send that one batch
  on restart. Entries are then duplicated; the receipts (seq + content hash) make that
  identifiable, and `GET /api/entries?q=<text>` finds them.
- Within a batch, the server accepts or rejects each entry independently. Rejections are
  printed (`server rejected N entries: #4 entry.action is required`) and the offset still moves:
  the batch was answered, and re-sending malformed entries forever would just wedge the ship.

## Failure handling

| Response | Behaviour |
| --- | --- |
| `202` | Batch accepted, receipts printed. |
| `408`, `425`, `429`, `5xx`, network error, timeout | Retried with exponential backoff: attempts at 0 ms, 500 ms, 1500 ms (3 attempts total). Then the run fails loudly. |
| `400`, `401`, `403`, `413` | Permanent: **not** retried. The server's reason is printed and the run exits 1. A wrong `INGEST_KEY` is retried three times only if the server answers 5xx, never on 401. |
| `2xx` without a JSON receipt body (captive portal, proxy error page) | Treated as a failure, not as success. |

A failed pass exits 1 with the offset at the last accepted batch, so re-running resumes at the
failed batch. Nothing in the state file is lost.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Completed, or stopped cleanly with Ctrl-C. |
| `1` | Unrecoverable error: missing file, ingest refused, retries exhausted. |
| `2` | Bad usage (missing/invalid flags). |
| `130` | Second Ctrl-C while already stopping. |

## Following in production

`--follow` uses polling (1 s), not inotify, so it works the same on Linux, macOS and Windows,
and it survives logrotate without holding the file open. On Linux, run it under systemd:

```ini
[Unit]
Description=Trackfoots log shipper
After=network-online.target

[Service]
Environment=INGEST_KEY=...        # or EnvironmentFile=/etc/trackfoots.env
ExecStart=/usr/bin/node /opt/trackfoots/scripts/shipper.js \
  --file /var/log/auth.log --url https://logs.example.com --key ${INGEST_KEY} \
  --follow --batch 100 --state /var/lib/trackfoots/auth.shipper-state.json
Restart=always
RestartSec=5
# Ctrl-C semantics: SIGTERM finishes the batch in flight, flushes and exits 0.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Notes for operators:

- Keep the state file on persistent storage. On tmpfs, every restart re-ships the current file.
- `logrotate` needs nothing special: truncation is detected by size, rename-rotation by inode.
  A line written into the *old* file after rotation but before the switch is shipped when the
  shipper next reads it — if the path already points at the new file, that line is gone, as it
  would be for any reader. Use `copytruncate` or `delaycompress` if that gap matters.
- One state file per log file. `--state` makes that explicit when several logs are shipped by
  separate units.
- The key is read from the command line or environment; it is never written to the state file.
  Prefer `EnvironmentFile` over `--key` on a shared host, since `--key` is visible in `ps`.
- Point `--url` at HTTPS when the server is not on localhost. Nothing in the shipper downgrades
  or ignores TLS.

## Dry run

```bash
node scripts/shipper.js --file samples/auth.log --dry-run
```

Prints the banner, then one line per batch that *would* be sent, with the byte range. It does
not call `fetch` and does not create or modify the state file, so it is safe to run on a
production box before wiring the real thing up.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401 invalid or missing x-api-key` | `--key` does not match the server's `INGEST_KEY` (note `lib/env.js` loads `INGEST_KEY` from `.env`). |
| `503 ingest disabled` | The server has no `INGEST_KEY` set. |
| `format unknown` in the banner | None of the first 200 lines parsed. Wrong file, or a format the parser does not cover (JSON logs, Windows event logs). |
| `0 entries accepted, N lines skipped` | Everything parsed was filtered out — usually `--format` names the wrong grammar. |
| Entries duplicated after a restart | The process died between the server accepting a batch and the state write. At-least-once by design; dedupe on the receipt content hash. |
| `state was for <other file>` | `--state` points at a state file belonging to a different log; the shipper starts this file at 0 rather than reusing the offset. |
| Exit `2` with usage | Missing `--url`/`--key` (both are required unless `--dry-run`). |

## Tests

`tests/shipper.test.js` covers the argument parsing, byte-offset reading, partial lines,
truncation and inode rotation, state round-trip and corruption, batching, resume, retry/backoff,
permanent failures, per-entry rejections, follow-and-flush, the CLI banner and exit codes, and
one end-to-end pass over real HTTP against a throwaway ingest server.

```bash
node --test tests/shipper.test.js
```
