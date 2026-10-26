# P4 — capacity reporting and deployment guard

## Policy

All MB values are decimal: **1 MB = 1,000,000 bytes**. The project's policy is based on the complete, uncompressed Pages output directory, not the uploaded ZIP or GitHub's repository-size estimate.

| Pages artifact bytes | Level | Behavior |
|---|---|---|
| Below 500,000,000 | normal | Continue |
| From 500,000,000 | warning | Warn and continue |
| From 700,000,000 | high | Stronger warning and continue |
| From 850,000,000 | critical | Near-limit warning and continue |
| From 950,000,000 | blocked | Write report, fail build, do not emit Pages path or upload/deploy the site |

950 MB is this project's conservative guardrail below the documented 1 GB published-site limit; it is not GitHub's own threshold. Source-repository size guidance and published-site size are different metrics. Reference: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits

## Report contents and location

The build measures active catalog projects only: project count, file count, decoded source bytes, actual preview JSON bytes, complete artifact bytes, all project rows and top 10 projects ranked by preview bytes. Cache hits and uncached builds use the same counters. Orphaned project directories absent from the catalog are not included in active-source totals.

`capacity.json` is written to `.build/reports-<timestamp>/`, a sibling of the Pages artifact directory. It is not added to the public site. Check and Publish workflows upload it separately as `showcase-capacity-<run-id>-<attempt>`. Download it from the workflow run's Artifacts section; the main numbers and top 10 also appear in GitHub Actions Summary. Failed-capacity builds still run the report upload step.

Repository size comes from the GitHub repository metadata `size` field, displayed in API-reported KB. It is advisory, can lag behind repository changes and is not a measurement of history alone. No full-history fetch, Git rewrite or remote garbage collection is performed. Missing API access, rate limiting, timeout or malformed responses produce `status: unavailable, sizeKilobytes: null`, never a made-up zero. API-returned zero is treated as an available measurement.

The CLI uses the runtime `GITHUB_REPOSITORY` and read-only workflow `GITHUB_TOKEN`; neither token nor raw API errors/responses are written to the report. Local builds do not request repository metadata unless a repository is provided.

## Local use

```powershell
node scripts/build-showcase.ts <commit-sha> --cache --repository=Kintinz/showcase
node scripts/check.mjs
```

Programmatic `buildShowcase(root, out, sha, { stats })` retains its existing path-returning contract and provides the report in `stats.capacity`; it does not publish or deploy. The CLI's report/output step enforces the 950 MB gate before publishing a Pages output path. A custom deployment caller must enforce the same capacity policy explicitly.

## If a build is blocked

1. Open its capacity summary and download the JSON report. The source has already been committed; the new upload is not necessarily available on Pages.
2. Check the top projects and the gap between source and base64 preview bytes. Optimize oversized images/fonts/assets or choose specific projects for removal through the existing explicit delete flow.
3. Build again and confirm the new artifact is below 950 MB before deployment. The previous deployed site stays available until a new deployment succeeds.
4. If active source is small but the repository estimate keeps growing, investigate history separately. Normal project deletion removes current files, not old commits. Do not assume running local `git gc` shrinks the hosted repository.
5. If capacity remains near the limit, design a separate migration to repositories by year/team, including ownership, URL continuity, deployment configuration and a backup/rollback plan. This phase does not perform that migration or history rewrite.

Upload limits remain unchanged: 2 MiB upload, 10 MiB expanded data, 20 files. No per-user quota or frontend upload guard was added. The capacity check is a CI deployment guard after Git commit, not a server-side write quota.

## Verification

Unit tests use synthetic byte counters for all exact boundaries and adjacent values; no near-1-GB fixture is generated. Tests verify aggregation/top-ten ranking, absent API data versus zero, token-safe API failure handling, blocked-build report availability, no Pages output on failure, normal Pages outputs and cached/fresh metric equality. Existing preview/sandbox/authorization tests remain in the full suite.

Live CI report upload and blocked-deploy behavior require a hosted workflow run after push; local tests and workflow source review do not prove that hosted run.
