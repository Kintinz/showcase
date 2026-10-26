# P3 — preview package cache and CI, 2026-10-26

## Behavior

`node scripts/build-showcase.ts <commit-sha> --cache` enables optional local package caching under `.build/preview-cache`. Existing callers of `buildShowcase(root, out, sha)` and builds without `--cache` remain supported. The optional fourth argument accepts `{ cacheDir, stats }` and still returns the artifact path.

Cache contains only packaged file maps, format version and a fingerprint. The namespace includes build/cache/validator code and Node major version. Each project's fingerprint includes its slug and ordered tracked paths, file modes and blob SHAs. Repeated edits replace the generated cache entry for that slug, rather than accumulating one entry per edit.

Only a clean Git checkout at the requested SHA can reuse cache. Dirty, untracked or ignored project files, non-Git sources, autocrlf conversion and text/filter/encoding/ident attributes fall back to source packaging. This deliberately includes this user's normal Windows checkout with core.autocrlf=true; benchmark fixtures set autocrlf=false in their own disposable repos. No user Git settings are changed.

Cache hits validate supported paths, exact file set, canonical base64, entry/expanded/file size limits and decoded file hashes against Git's blob SHA. A self-reported cache checksum alone is not trusted. Missing, corrupt, incompatible or substituted cache data rebuilds from source. An unavailable cache directory or cache-service failure must not prevent an otherwise valid source build/deployment.

Every build emits a new complete Pages artifact. Current catalog metadata supplies each preview's uploadId; SHA and marker are generated fresh. Deleted catalog entries never enter the artifact even if a disposable cache entry remains. Only trusted viewer redirects are emitted; uploaded HTML/JS is still packaged as inert base64 for the sandbox.

## CI responsibility

- `Check`: pull requests targeting main and manual checks. Tests plus a complete uncached build; no cache writes or deploy.
- `Publish showcase`: main pushes and manual deployment. Tests must pass before cache restore, cached build, artifact upload and deploy.
- Restore/save of preview cache is restricted to main and allowed to fail. Cache is saved after a successful build only when packages were generated. Save uses an explicit key even if restore failed before producing outputs.
- Cache service keys include runner OS, Node24, packager code hash, commit SHA and run/attempt. Restore searches only the compatible code prefix. Actions/cache restore/save is pinned to immutable v4 commit `0057852bfaa89a56745cba8c7296529d2fc39830` from the official repository.
- Existing checkout/setup-node/Pages action versions are unchanged. Branch API reported main protected=false before editing; no branch rules changed.

## Reproduce benchmark

```powershell
node scripts/benchmark-build-cache.mjs
# Optional larger dataset, with more local disk/time required:
node scripts/benchmark-build-cache.mjs --sizes=100,1000,5000
node scripts/check.mjs
```

All data lives in disposable `.build` repos. Ten files per project, approximately 37 KiB source per project. Local Windows/Node timings exclude cache-service restore/save, GitHub checkout, artifact upload, queue time and deployment. They are not production timing guarantees.

| Projects | No cache | Cold cache | Warm cache | One project changed |
|---|---:|---:|---:|---:|
| 100 | 1,648 ms | 2,190 ms | 868 ms | 895 ms |
| 1,000 | 14,866 ms | 17,851 ms | 5,761 ms | 5,177 ms |

At 1,000 projects, warm build reused 1,000 packages; one-change reused 999 and packaged 1. The artifact was 49,943,576 bytes for unchanged input. No-cache/cold/warm complete artifacts had the same SHA-256. Warm was about 61% faster than no-cache in this single local run; cold was slower because of cache creation/validation.

Raw results: `performance-p3-results.json`. CLI logs and GitHub step summary expose project count, cache hits, packaged count, invalid cache count, artifact bytes, elapsed time and cache mode. `cacheWritesFailed` is also logged.

## Verification and limits

- Tests cover full cached/uncached artifact equality, one changed project, renamed asset, missing index, fresh uploadId, deleted catalog entry, corrupt/tampered cache, code-version invalidation, dirty/untracked/ignored source, CRLF/attribute transformations, blocked cache path and cache/output separation.
- Existing authorization, metadata, sandbox and publish/status tests remain required.
- This phase does not reduce artifact size, whole-artifact upload, Git history growth or initial Git checkout cost.
- Full UI files, redirects and marker are still rebuilt. Warm cache still reads JSON, verifies hashes and writes the full artifact.
- GitHub cache entries are disposable and storage-limited. Restoring/saving a large cache can outweigh build savings, especially for small repositories. Old deleted-slug entries can remain in cache but cannot reappear on the site.
- GitHub Actions trigger/restore/save/deploy behavior requires a real run after push. Local source tests do not prove the hosted workflow succeeded.
