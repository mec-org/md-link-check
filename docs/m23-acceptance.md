# M23 acceptance report — v0.4 hardening, documentation and real-docs run

- Milestone: M23, “v0.4 hardening, documentation and real-docs run”
- Authorized base: `d8b312a79866291e0550d2fbdb9d68f192e39ead` (the M22 merge)
- Exact reviewed PR head: recorded in the pull-request body, so the PR, the
  checks and this record name the same commit.
- Scope: `src/`, `test/`, `docs/`, `README.md`, `action.yml`,
  `action-dist/index.cjs` only.
- Outcome: the v0.4 definition of done (PROJECT.md) is traced to evidence
  below, except the items that can only be observed after the operator merges
  and pending required PR checks. No release or tag was created or moved.

All generated evidence is stored outside both the md-link-check checkout and
the read-only `dsh-copilot` snapshot: `/tmp/m23-v04-real-docs.ae7C41` (the
`<evidence>` directory below). The repository contains only the deliberate M23
changes listed under [Changed paths and scope](#changed-paths-and-scope).

## Changed paths and scope

`node scripts/check-scope.mjs --json --base d8b312a79866291e0550d2fbdb9d68f192e39ead`
reported mode `git-diff`, `violations: []`, and these changed paths (before the
acceptance document itself was added):

- `README.md`
- `test/m14-exit-usage-interaction.test.ts` (adds the M23 packet files to the
  historical later-milestone allowlist)
- `test/m16-artifact-scope.test.ts` (brings its stale README release-tag
  assertion in line with the tags that exist; the v0.3 tag provenance checks are
  unchanged)
- `test/m16-readme-contract.test.ts` (same stale release-tag assertions)
- `test/readme-contract.test.ts` (same stale release-tag assertion)
- `test/m23-base-manifest.json`
- `test/m23-helpers.ts`
- `test/m23-readme-contract.test.ts`
- `test/m23-release-tags.json`
- `test/m23-scope.test.ts`
- `test/m23-v04-hardening.test.ts`
- `docs/m23-acceptance.md` (this document)

The committed `test/m23-base-manifest.json` records the exact base tree
(145 blob paths, `git-blob-sha1`), so `test/m23-scope.test.ts` evaluates the M23
diff in a shallow CI checkout without fetching history. It allows only
`src/**`, `test/**`, `docs/**`, `README.md`, `action.yml` and
`action-dist/index.cjs`; it reports every other path as a violation.

`package.json`, `package-lock.json`, `scripts/`, `.github/`, `.project/`,
`PROJECT.md`, `ROADMAP.md` and `PRD.md` are unchanged. `action.yml` is
unchanged: the v0.4 summary is behavior of the already-declared action, and it
adds no input, output or runtime metadata. The v0.3 annotations, outputs and
inputs are unchanged.

## Required named-test mapping

### `test/m23-v04-hardening.test.ts` — real action path, independent oracles

| Required responsibility | Exact test name |
| --- | --- |
| 1. More than fifty findings, exact counts, first/fiftieth, 51 absent, total/omitted | `formats a multi-file run with more than fifty findings` |
| 2. Order across files, images and anchors; no sorting/grouping/mutation/deduplication | `preserves result order across files images and anchors` |
| 3. Escaping of every listed value, including line breaks and controls | `escapes every listed diagnostic value in the integrated summary` |
| 4. Offline external classification, zero transport attempts | `preserves offline external classification without fetching` |
| 5. Loopback external classifications, no extra request from summary | `preserves external classifications with a loopback server` |
| 6. Frozen v0.3 CLI text/JSON, annotations, outputs, order, exits; direct CLI isolation | `preserves v03 action surfaces while adding the summary` |
| 7. Summary failure secondary, exactly one warning | `keeps summary failure secondary` |
| Base provenance guard | `starts from the authorized M23 base` |

### `test/m23-readme-contract.test.ts` — README contract

| Required responsibility | Exact test name |
| --- | --- |
| 8. Actual count names, order, 50 limit, overflow, escaping, exactly-once, action-only, fail-safe warnings, exits, offline default, external opt-in | `documents the v04 run summary contract` |
| 9. Only release tags that exist; pinned v0.3 provenance; no v0.4 tag | `states only release tags that exist` |

### `test/m23-scope.test.ts` — scope and bundle

| Required responsibility | Exact test name |
| --- | --- |
| 10. M23 changes limited to authorized paths against the exact base | `limits M23 changes to authorized paths` |
| 11. Committed bundle matches a fresh build | `keeps action-dist current` |

The M23 suite deliberately reuses the committed M16/M17 v0.3 fixture and its
frozen bytes instead of recapturing them, and uses the repository's existing
`scripts/build-action.mjs --check` rather than a competing artifact verifier.

## Synthetic hardening fixture

`test/m23-helpers.ts` builds one deterministic multi-file fixture (no binary
bulk) with three Markdown files and 67 default-mode local findings:

- `README.md`: 4 fixed findings (relative file, relative image, same-file
  anchor, cross-file anchor) plus 40 generated relative file targets in a
  deliberately non-sorted order;
- `docs/extra.md`: 10 relative file findings plus 2 later uses of the same
  missing target (duplicate-preservation proof);
- `docs/guide.md`: repeated `## Repeat` headings (real `#repeat` and
  `#repeat-1`; missing `#repeat-2`) plus 10 relative image findings.

The same fixture carries an HTTP success and a terminal 404 on a loopback
origin. Default mode counts both as skipped and never fetches them; external
mode checks only the loopback server and keeps the existing `succeeded`,
`failed`, `external HTTP 404` and count classifications. A second compact
escaping mode uses file names containing `|`, a line break, a tab, a backtick,
`*`, `[`, `]`, `&`, `<`, `>`, a C0 control, and targets containing Markdown and
table-sensitive punctuation.

## v0.4 definition-of-done traceability

| PROJECT.md item | Implementation or evidence | Proving test or command | Result | Pending |
| --- | --- | --- | --- | --- |
| 1. M17–M23 merged in order, one issue and PR each, within the factory changed-line limit including `action-dist` | M17–M22 are merged on `main`; this M23 PR is the single M23 issue/PR and touches only authorized paths | `git log --oneline`; `test/m23-scope.test.ts`; PR diff | Pass for the local/PR evidence | M23 merge by the operator |
| 2. Exactly one summary for clean, broken and usage runs; counts equal the run's summary fields | M20/M21 integration plus the M23 fixture; summary counts are read from the authentic structured result | `appends exactly one summary for a clean action run`, `appends exactly one summary for a broken action run`, `writes one usage summary and no normal counts when no check completed`, `preserves v03 action surfaces while adding the summary` | Pass | — |
| 3. Result-order diagnostics; first 50 listed; total/not-listed exact; ≤50 lists all | M19 formatter and M20 integration, exercised through the committed bundle | `formats a multi-file run with more than fifty findings`, `preserves result order across files images and anchors`, `limits the action summary to fifty diagnostics with the overflow disclosure`, `lists exactly fifty diagnostics`, `limits fifty-one diagnostics and reports one not listed` | Pass: 67 findings → 50 listed, `67 total diagnostics; 17 not listed.`; 51st (`gone07.md`) absent; 16-finding fixture lists 16 | — |
| 4. Escaping of Markdown-special values; structure unchanged; one entry each | M18 escaper through the action; independent oracle in the M23 helper | `escapes every listed diagnostic value in the integrated summary`, M18/M19 escaping tests | Pass: exact bytes for `|`, newline, tab, backtick, `*[]&<>$~`, and C0 `\u0001`; no added row, heading, link or HTML structure | — |
| 5. Unset/unwritable summary changes nothing else; reported once as a warning | M21 orchestration plus M23 integration | `keeps summary failure secondary`, `warns once and writes nothing when GITHUB_STEP_SUMMARY is absent`, `keeps the completed result and warns once when the destination is unusable` | Pass: one `::warning::`, unchanged stdout/annotations/outputs/exit 1 | — |
| 6. Printed output, annotations and outputs byte-for-byte v0.3; direct CLI writes no summary | Committed M16/M17 fixture and frozen expected bytes | `preserves v03 action surfaces while adding the summary`, `M20 appends one job summary without changing the frozen v0.3 surfaces`, `direct CLI ignores summary destinations and writes no summary` | Pass | — |
| 7. Exit codes 0/1/2, CLI options, JSON fields and action inputs/outputs unchanged | Existing frozen v0.3 surfaces plus M23 clean/broken/usage runs | `exit behavior is unchanged`, `preserves v03 action surfaces while adding the summary`, M14/M16 suites | Pass: clean 0, broken 1, usage 2; no option/JSON/input/output change | — |
| 8. No real network; loopback-only external fixtures; offline default | Existing network guard and loopback fixtures; M23 default guard run | `preserves offline external classification without fetching`, `preserves external classifications with a loopback server`, `network-guard.test.ts`, real-docs guard runs | Pass: default guard log absent; external run requests only `GET /ok` and `GET /not-found` on the test server | — |
| 9. No v0.4 changes to package/lockfile/scripts/`.github`/`.project`/charter; bundle current; CI green on `main` | M23 scope test and bundle check; main CI cannot be claimed before merge | `limits M23 changes to authorized paths`, `keeps action-dist current`; `npm run check:action`; PR checks | Local and PR evidence pass; `action-dist/index.cjs` matches a fresh build; main CI pending | Main CI after operator merge |
| 10. README documents summary, limit, fail-safe; release statements match existing tags; v0.4 release/tag decision handed to owner | README updated; local tag provenance inspected; owner decision recorded | `documents the v04 run summary contract`, `states only release tags that exist`; `git tag --list` | Pass: README names `v0.2.0`/`v0.3.0` only, says no v0.4 release tag exists; owner decision explicit below | Owner release/tag decision |

## README release-tag evidence

Local tags were inspected with `git tag -l --format='%(refname:short) …'` in a
full checkout:

| Tag | Tag object | Peeled commit | README statement |
| --- | --- | --- | --- |
| `v0.2.0` | `3b81b09ef1fda1e4cef5b8903e62a80ea8d6d018` | `b87260f2b5ee46f5b50758c8f69f5dc3c93cff39` | exists; marks v0.2 |
| `v0.3.0` | `391e0961b6b024d2458d17932927bf72bc173db3` | `4438906e6e6085c941faf3117c2aaca1824a073d` | exists; marks v0.3 at the owner-approved M16 commit |
| v0.4 | — | — | no v0.4 release tag exists yet; v0.4 behavior is implemented but unreleased |

`test/m23-release-tags.json` records the same provenance for a shallow CI
checkout, and `states only release tags that exist` compares the README with
those facts (and with local Git tags when present). No tag was created, moved
or pushed by M23; `v0.4` is not claimed as tagged or released. The M16/M22
owner-approved v0.3 pin and charter pins remain intact
(`PROJECT.md` blob `ea3d2ee55f766b0d30956754e4908fa578c6c5c7`,
`ROADMAP.md` blob `b7c34bd3902a0a26551d6fb1bb7266134a5fddeb`).

## Action bundle regeneration

Commands, run from the repository root:

```text
npm run build                        # tsc build, exit 0
npm run build:action                 # sha256 action-dist/index.cjs = 3280ff18c42325543c4786ad2615a7765ad5be22cccd5b30704476896754b920
npm run build:action                 # second build: same sha256
npm run check:action                 # "action entrypoint is reproducible: action-dist/index.cjs"
npm ls --omit=dev                    # no runtime dependencies
```

The second build produced the identical artifact, `git status --short` showed
no change under `action-dist/`, and the committed bundle already matched the
fresh build; no hand edit was made. The M23 diff does not change
`action-dist/index.cjs`, so the reviewed head keeps the current bundle.

## Real-docs snapshot preflight

Snapshot, used exactly as specified:

```text
/opt/dsh-factory/snapshots/dsh-copilot@fc98b7b953f59f4e747d14164119770f1777e96d/
```

| Property | Observation |
| --- | --- |
| Exists and readable | yes; all files readable by the run user |
| Effective revision | `fc98b7b953f59f4e747d14164119770f1777e96d`, encoded in the exact directory name |
| Git metadata | absent (`.git` missing; `git rev-parse` fails: “not a git repository”); no fetch or substitution attempted, so the revision is verified from the required path name only — a recorded limitation |
| Ownership / mode | `root:root`, directory mode `755`; `test -w` reports not writable for the run user |
| Symlinks | none |
| Files / directories | 154 files, 11 subdirectories (12 directories including the root), 0 symlinks |
| Markdown files | 18 |
| Mapping | `test/fixtures/m16-multifile` precedent is not used here; the exact snapshot is the working directory |
| Pre-run inventory | 165 entries (154 files + 11 directories), SHA-256 of the canonical inventory JSON = `307be0b9f02d0c854b90cbb7033e5e441ede1f8851ee029e996314ecb1ed1562` |

The snapshot is not a Git checkout, so no commit identity can be re-derived
from `.git`; the exact required path name is the identity evidence, matching
the M16 precedent. The snapshot was not copied, replaced or written to.

## Offline real-docs commands and results

Working directory for all snapshot runs: the snapshot root. Environment
controls for the CLI runs:

```text
MDLC_ACCEPTANCE_CACHE_ROOT=<evidence>/audit-cache-<run>
MDLC_ACCEPTANCE_GUARD_LOG=<evidence>/guard-<run>.log
XDG_CACHE_HOME=<evidence>/xdg-<run>
GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, INPUT_PATHS, INPUT_EXTERNAL unset
node --require <repo>/test/offline-guard.cjs <repo>/dist/cli.js .
node --require <repo>/test/offline-guard.cjs <repo>/dist/cli.js --json .
```

Action-wrapper run (still offline, `external: false`):

```text
cd <snapshot>
INPUT_PATHS=. INPUT_EXTERNAL=false \
GITHUB_OUTPUT=<evidence>/action.GITHUB_OUTPUT \
GITHUB_STEP_SUMMARY=<evidence>/action-summary.md \
MDLC_ACCEPTANCE_CACHE_ROOT=<evidence>/audit-cache-action \
MDLC_ACCEPTANCE_GUARD_LOG=<evidence>/guard-action.log \
XDG_CACHE_HOME=<evidence>/xdg-action \
node --require <repo>/test/offline-guard.cjs <repo>/action-dist/index.cjs
```

| Run | Exit | Files | Broken | External skipped | stderr | Guard log | Snapshot inventory |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CLI text | 1 | 18 | 2 | 0 | empty | absent (zero entries) | identical |
| CLI JSON | 1 | 18 | 2 | 0 | empty | absent (zero entries) | identical |
| Action wrapper | 1 | 18 | 2 | 0 | empty | absent (zero entries) | identical |

Exit 1 is a completed run with confirmed broken links, not a failure: the
snapshot contains the two real local findings below. Exit 2 and internal
failures did not occur.

CLI text output (byte-for-byte):

```text
HANDOVER-ADCP.md:5: ../../AGENTS.md — target does not exist
docs/plan/foreman-v0.1-plan.md:120: url — target does not exist
Checked 18 files: 2 broken targets, 0 external links skipped.
```

The CLI JSON document has `version: 1`, `ok: false`, `exitCode: 1`,
`summary: { filesChecked: 18, broken: 2, externalSkipped: 0 }`,
`external.enabled: false`, and exactly the two diagnostics in the same order.

The action printed the unchanged CLI text, then exactly two annotations in
result order, and no warning:

```text
::error file=HANDOVER-ADCP.md,line=5::../../AGENTS.md — target does not exist
::error file=docs/plan/foreman-v0.1-plan.md,line=120::url — target does not exist
```

`GITHUB_OUTPUT` was exactly:

```text
files-checked=18
broken=2
external-skipped=0
```

The action appended exactly one summary fragment (one `## Results` section,
two listed diagnostics, no warning):

```markdown
## Results

- Checked: 18
- Broken: 2
- External skipped: 0

## Diagnostics

- HANDOVER\-ADCP.md:5: ../../AGENTS.md — target does not exist
- docs/plan/foreman\-v0.1\-plan.md:120: url — target does not exist
```

The direct CLI runs emitted no workflow command and wrote no step summary
(`GITHUB_STEP_SUMMARY` was unset; no `## Results` appeared in either output).

## No-network proof

`test/offline-guard.cjs` records and refuses `fetch`, `http(s).request`,
`net.connect`, `tls.connect`, DNS lookups, sockets, HTTP/2 and filesystem access
beneath the audit cache root. A positive control against a loopback unreachable
port produced exactly two refused `fetch` entries and the expected external
network-failure diagnostic, proving the guard was live. The three acceptance
runs produced no guard log (zero entries), so no HTTP(S) or DNS attempt was
made and no external cache was touched. The evidence cache directories were not
created; every artifact stayed under `<evidence>`.

## Independent confirmation of every local finding

Structured JSON was used, not scraped human output. Both reported diagnostics
are local file-link findings with `kind: "link"` and
`reason: "target does not exist"`; there were no image or anchor findings.

| ID | `file:line` (column) | Target | Source line checked | Resolution under md-link-check semantics | Direct filesystem evidence | Confirmation |
| --- | --- | --- | --- | --- | --- | --- |
| M23-REAL-1 | `HANDOVER-ADCP.md:5` (17) | `../../AGENTS.md` | `**Read first:** [AGENTS.md](../../AGENTS.md) §1 …` | `<snapshot>/../../AGENTS.md`, i.e. `/opt/dsh-factory/AGENTS.md` | target is absent (`test -e` false); `find /opt/dsh-factory -maxdepth 3 -name AGENTS.md` found none, and no `AGENTS.md` exists anywhere in the snapshot | `REAL_BROKEN_LOCAL_LINK` |
| M23-REAL-2 | `docs/plan/foreman-v0.1-plan.md:120` (214) | `url` | `… "[PR #N](url) is ready for review: …" …` | `<snapshot>/docs/plan/url` | target is absent (`ls` exit 2); `find <snapshot> -name url` found none | `REAL_BROKEN_LOCAL_LINK` |

Both are real broken links in the owner's read-only documents: the first
resolves outside the snapshot to a missing file, and the second is a literal
`url` template placeholder written as an ordinary Markdown link. Neither is a
tool false positive, and neither document was modified. Direct evidence is in
`<evidence>/finding-evidence.txt`; the machine-readable ledger is kept at
`<evidence>/checks.json`.

## Repository and snapshot cleanliness

- Pre-run and post-run snapshot inventories are byte-identical
  (SHA-256 `307be0b9f02d0c854b90cbb7033e5e441ede1f8851ee029e996314ecb1ed1562`
  both times): no file created, changed, deleted, chmodded or re-owned; no
  summary, output, cache, log, coverage, `node_modules` or temporary file
  appeared in the snapshot.
- Pre-run and post-run `git status --short` in md-link-check are identical
  (`<evidence>/repo-status-before.txt` and `repo-status-after.txt`) and contain
  only the deliberate M23 changes listed above; no untracked or unintended file
  exists. `dist/` and `node_modules/` are ignored build/install
  products, and all evidence is outside the repository.
- The captured artifacts remain under `/tmp/m23-v04-real-docs.ae7C41`, outside
  both the snapshot and the checkout.

## Verification commands and results

All commands were run from the repository root unless noted.

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | exit 0 (Node 26.12.0; repository requires ≥22.12.0) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm run build:action` ×2 | identical sha256 `3280ff18c42325543c4786ad2615a7765ad5be22cccd5b30704476896754b920` |
| `npm run check:action` | reproducible, exit 0 |
| `npm test` | 64 files, 1360 tests passed, exit 0 |
| M23 suites | `test/m23-v04-hardening.test.ts` 8 tests, `test/m23-readme-contract.test.ts` 2 tests, `test/m23-scope.test.ts` 2 tests — all pass |
| `npm ls --omit=dev` | no runtime dependencies |
| `node scripts/check-scope.mjs --json --base d8b312a…` | `mode: git-diff`, `violations: []` |
| Charter pins | `PROJECT.md` `ea3d2ee5…`, `ROADMAP.md` `b7c34bd3…`, unchanged |
| Local tags | `v0.2.0` and `v0.3.0` only; v0.3.0 peels to the owner-approved M16 commit |
| Real-docs CLI text / JSON / action | exits 1/1/1, 18 files, 2 broken, 0 skipped, zero guard entries, one action summary, snapshot unchanged |

## Pending evidence and owner-only decision

- Required PR checks: recorded in the pull-request body for the exact reviewed
  head. Main-branch CI is not claimed here: M23 is merged by the operator, and
  main CI can only be observed after that merge.
- Release and tag: **no v0.4 tag or release was created or moved**. The owner
  decides whether and when to create one after this PR is merged; the README
  states v0.4 is implemented but not released. Existing tags are `v0.2.0` and
  `v0.3.0`.

## Issue assumptions checked

- The specified snapshot exists, is readable and is root-owned/read-only: true.
- PROJECT.md contains the authoritative v0.4 definition of done: true; it was
  read and traced above without modification.
- Local Git tags are authoritative: true; `v0.2.0` and `v0.3.0` were inspected
  and no `v0.4*` tag exists.
- M22 helpers support no-network and local action runs: true; the M23 suite
  reuses the established guard, loopback server and action harness.
- Repository governance may reserve merge authority: true for this deployment;
  the agent did not merge, approve or enable auto-merge.
- Main CI can be claimed only from observed post-merge evidence: true; it is
  therefore left pending rather than inferred.
- M23 authorizes no release or tag creation: true; none was created.
