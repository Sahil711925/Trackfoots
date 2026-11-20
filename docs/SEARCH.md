# Searching the log stream

The dashboard's **Log stream** card no longer shows only the newest handful of
lines. It reads the full log through `GET /api/entries` and keeps a query, a
page size and an offset in page state.

## What the operator gets

| Control | Behaviour |
| --- | --- |
| Search box | Free text, matched **server-side** against `actor`, `action` and the JSON body of `meta`. Debounced 250 ms, so the table updates while you type without a request per keystroke. |
| Actor quick-filter | Click any actor name in any row. Clicking the same actor again clears it. Combines with the text query (`actor=` + `q=`). |
| Filter chips | The active query and actor appear as removable chips above the table. A `clear filters` button appears whenever either is set. |
| Page size | 25 / 50 / 100 rows. Changing it (or any filter) resets to page 1. |
| Counter | `1–50 of 1,200`, where the denominator is `total` from the API — i.e. the number of entries that *match the current filters*, not the size of the whole log. |
| Prev / next | Disabled at the ends of the range. |
| Empty state | `No entries match "<query>"` (or `actor "<name>"`) with an inline clear button. |

Keyboard: `/` focuses the search box from anywhere on the page (ignored while
typing in another field); `Esc` in the search box clears it, and clears all
filters if the box is already empty.

## Endpoint

```
GET /api/entries?q=<text>&actor=<name>&limit=<1-500>&offset=<n>
→ { total, matched, offset, limit, entries: [...], filters: {...} }
```

Entries are returned **newest first**. `total` is the post-filter count
(`matched` currently mirrors it). `limit` is clamped to 500 by the server and
the clamped value is echoed back.

## Live refresh

The page still polls `GET /api/state` every 4 s. That refresh calls
`refreshLog()` too, but it re-sends the *current* query, limit and offset, so
the filter text, the active actor filter and the page you are on survive every
poll — only the rows inside the current window are replaced.

Two guards keep the table honest while requests are in flight:

- a monotonically increasing request token, so a slow response cannot overwrite
  a newer one;
- the query string is compared with the one the response was requested for, so a
  poll that started before you changed a filter can never paint rows belonging
  to the old filter.

If the window drifts past the end of the result set (entries added or deleted
while you sit on the last page), the offset snaps back to the last full page.

Mutation buttons (attack / reset / forge receipt) re-render the table with the
current filters and, for reset, drop back to page 1. Nothing in the action bar,
the banner, the proof panel or the published-roots column changed.

## Constraints respected

Dependency-free, no CDN, no external fonts, no build step — inline CSS and
vanilla JS in `public/index.html`, using only the CSS variables already defined
in `:root`.
