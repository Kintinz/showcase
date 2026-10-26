# Performance P0 + P1 — 2026-10-26

Scope: static GitHub Pages, no server, no owner index/migration, no workflow configuration changes. Measurements use disposable local fixtures, not GitHub network timings or production SLOs.

## Reproduce
```powershell
node scripts/benchmark-showcase.mjs
node scripts/benchmark-operations.mjs
node scripts/check.mjs
node tests/pages-browser-fixture.mjs --performance
```
Browser fixture: localhost:4175/showcase/, disposable token `fixture-token` only. It seeds 56 owned projects and one other user's project. No fixture modules are published.

## Catalog measurements
Connection requests are excluded. Cold means first read; warm means another read on the same connected client, not a full browser reload.

| Projects in repo | Owned | Cold requests before/after | Warm requests before/after | Peak concurrent requests before/after |
|---|---:|---:|---:|---:|
| 100 | 10 | 104 / 104 | 104 / 4 | 1 / 4 |
| 1,000 | 100 | 1,004 / 1,004 | 1,004 / 4 | 1 / 4 |
| 5,000 | 500 | 5,004 / 5,004 | 5,004 / 4 | 1 / 4 |

At 5,000 projects, this local run measured cold/warm catalog 1061/880 ms before, 731/83 ms after. These are fixture CPU/scheduling timings with no network latency; the request counts are the useful comparison. Four warm requests still revalidate identity and read current HEAD/commit/tree.

## Upload and deployment checks
- Blob stage with 20 small files and artificial 5 ms delay/request: 20 requests in either mode, peak 1 → 4; measured 334 → 78 ms. This excludes validation, tree/commit writes and deployment.
- One cycle with 20 waiting jobs and a missing Pages marker: GitHub requests 60 → 22, marker requests 20 → 1, workflow-list requests 20 → 1. The marker JSON is parsed only once per batch when present. Per-job commit ownership and upload identity remain independently checked.
- Polling after an immediate check uses 12, 20, then 30 seconds between cycles. Hidden tabs stop starting periodic cycles; in-flight work can finish. Returning to a visible tab checks immediately. Explicit manual checks remain available.

## Build baseline
Small synthetic HTML per project; total project source at 5,000 projects is only 355,000 bytes. No large-image/ZIP build benchmark is claimed.

| Projects | Build before (ms) | Build after (ms) | Pages bytes after |
|---|---:|---:|---:|
| 100 | 514 | 661 | 136,642 |
| 1,000 | 5,597 | 5,862 | 560,542 |
| 5,000 | 24,915 | 28,430 | 2,460,542 |

P1 does not optimize build time. Every deployment still packages all projects and produces a complete artifact. Run-to-run filesystem variation is visible; these numbers are not evidence of a build speedup. Raw reports are retained in performance-p0-p1-results.json.

## Cache, UI and correctness
- Cache is in memory in one authenticated adapter, scoped to its repo/account and cleared on disconnect. Same SHA returns cloned data; changes fetch the new blob and deleted entries are pruned after a fresh snapshot.
- At most 6,000 cached records and 8 MiB of serialized metadata bytes. Individual metadata over 64 KiB remains readable but is not cached. JavaScript object overhead is additional; this is not an exact heap-memory cap.
- Catalog requests and blob uploads use four workers per operation. A failed blob drains already-started requests and prevents commit creation. Concurrent independent operations can each have their own four workers.
- UI renders 24 cards/page, searches all loaded owned projects and resets the page for a new search. Pagination reduces DOM size, not cold metadata requests.
- Existing permission, owner, retry/conflict, revoked token, sandbox and deployment uploadId tests remain required. HTTP 401 during shared workflow/compare calls must not be hidden by fallback status handling.

## Remaining limits
- Full recursive Git tree and all metadata still need reading on a cold load. Very large trees can still be truncated; owner indexing/subtree reads belong to P2.
- A full reload creates an empty metadata cache; saved token persistence does not persist catalog cache.
- Repo history, artifact size and total build work are unchanged. Build caching and size governance belong to later phases.
- Browser smoke uses a local in-memory GitHub fixture, not a real PAT or production deploy.
