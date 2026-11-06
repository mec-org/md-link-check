# M16 acceptance report — v0.3 hardening, documentation and real-docs run

- Milestone: M16, “v0.3 hardening, documentation and real-docs run”
- Issue: #42
- Authorized base: `4c821d201072b3fe00ebd053605e95cf7d5e8a93`
- Starting `HEAD`: `4c821d201072b3fe00ebd053605e95cf7d5e8a93` (clean isolated worktree)
- Branch: `agent/hardening-docs-v3-17e95c4a4507`
- Final commit: the head of PR #43 (see the pull request for the exact SHA); the artifacts, gates and acceptance evidence were verified at that head.
- Pull request: [#43](https://github.com/mec-org/md-link-check/pull/43)
- Environment: Node.js `v22.23.4`, npm `10.9.9`, Linux, offline acceptance runs

This report keeps the engineering evidence for M16. Machine-specific worktree and
evidence paths are omitted; all raw acceptance evidence is stored **outside the
checked repository**, on a local temporary filesystem, and is not committed.

## Scope and production change

M16 is a hardening, documentation and acceptance milestone. The real-docs run
reported only real broken links in the read-only snapshot, so no production
source or bundled-artifact change was required or made. The production tree
(`src/`, `action.yml`, `action-dist/index.cjs`) is unchanged from the authorized
base; the checked-in artifact hash is
`e6e5bf7779cf4d291f1dcca994afbe1c0f754f2b24da63ef9aacb9c8ad5ca237`.
Changes relative to the base are confined to `README.md`, `docs/`, `test/`
(including fixtures and the base manifest) and the M14 scope-test allowlist
update required by the new M16 paths.

## Baseline verification at the authorized base

| Check | Result |
| --- | --- |
| `HEAD` equals `4c821d201072b3fe00ebd053605e95cf7d5e8a93` | pass |
| Isolated worktree clean (`git status --porcelain` empty) | pass |
| `npm ci` | pass |
| `npm test` (Node 22) | pass, 1181 tests |
| `npm run typecheck` (Node 22) | pass |
| `npm run build` (Node 22) | pass |
| `npm run build:action` | pass |
| `npm run check:action` | pass, reproducible |
| `npm ls --omit=dev` | empty, zero runtime dependencies |
| `PROJECT.md` v0.3 definition of done read and enumerated | pass |
| `ROADMAP.md` M16 contract read | pass |
| Actual local tags inventoried | `v0.2.0` only |
| Required real-docs snapshot exists, readable, read-only | pass |
| `.github/` and `.project/` unchanged | pass |

Script mapping: `npm test` runs the `pretest` build and then `vitest run`;
`npm run build` is `tsc -p tsconfig.build.json`; `npm run build:action` and
`npm run check:action` run `scripts/build-action.mjs` in write and `--check`
modes; `npm ls --omit=dev` lists installed production dependencies (empty).

## Actual tags and README truthfulness

Commands used:

```text
git tag --list --sort=version:refname      -> v0.2.0
git show-ref --tags                        -> 3b81b09ef1fda1e4cef5b8903e62a80ea8d6d018 refs/tags/v0.2.0
git log -1 --format='%H %s' v0.2.0^{}       -> b87260f2b5ee46f5b50758c8f69f5dc3c93cff39 M8: v0.2 hardening, README contract and offline real-docs evidence (#22)
```

No tag was created, moved or deleted, and no release exists. `v0.2.0` is an
annotated tag whose commit is the M8 merge; it predates the v0.3 annotations and
outputs, so the README action example keeps a `<tag>` placeholder for the v0.3
surface.

README statements before M16 (at the authorized base):

- status: “the v0.2 interface is implemented and tested”
- status and action example: “no release tag exists yet”
- current limitations: “No release tag exists yet”

README statements after M16:

- status: “the v0.3 interface is implemented and tested”
- status and action example: “the `v0.2.0` tag exists, but no v0.3 release tag
  exists yet”; `<tag>` is a placeholder for the v0.3 surface
- the v0.2.0 tag is documented as not containing the v0.3 annotations/outputs
- “M16 creates no tag or release”; v0.3 release and tag decisions remain the
  owner’s
- `test/m16-readme-contract.test.ts` and the updated M8 README contract test
  enforce these statements, the three output names, the annotation behavior,
  the unchanged direct CLI, the exits and the npm non-goal.

## v0.3 definition of done

The complete `PROJECT.md` v0.3 list, one row per requirement:

| # | Requirement | Evidence | Status |
| --- | --- | --- | --- |
| 1 | M9–M16 merged in order, one issue/PR each, within the factory changed-line limit | `git log` shows the merged M9–M15 PRs at the base; M16 is this single PR. Changed-line totals are reported by the PR/gate. | satisfied through the base; M16 PR to be gated |
| 2 | Exactly one workflow annotation per broken finding, in CLI result order; clean run none | `test/m11-annotation-values.test.ts`, `test/m12-action-annotations.test.ts`, `test/m16-*` annotation tests, and the real-docs run (2 findings → 2 annotations) | pass |
| 3 | Special characters in file names, targets and reasons keep one annotation with values intact | `test/m11-annotation-values.test.ts` (94 focused tests) and the M16 annotation-bounds test | pass |
| 4 | Action still prints the CLI output unchanged, line for line; annotations additional | `test/m12-action-annotations.test.ts`, `test/m16-cli-action-contract.test.ts`, empty stderr in all real-docs runs | pass |
| 5 | `action.yml` declares summary outputs whose values equal `summary.filesChecked`, `summary.broken`, `summary.externalSkipped` for clean, broken and external fixtures | `test/m13-action-outputs.test.ts`, `test/m15-*`, M16 output tests and the real-docs action outputs (`18`, `2`, `0`) | pass |
| 6 | Direct CLI emits no workflow command and needs no Actions environment | `test/m12-*`, `test/m14-*`, `test/m15-direct-cli.test.ts`, M16 direct-CLI tests, real-docs `GITHUB_OUTPUT` check | pass |
| 7 | Exit codes 0/1/2, CLI options, JSON fields and action inputs unchanged with and without `--external`; usage error never becomes a broken-link annotation | `test/m13-*`, `test/m14-*`, `test/m15-*`, M16 CLI/action tests; real-docs exit 1 with unchanged text/JSON | pass |
| 8 | Tests use no real network; external-mode tests use a loopback HTTP fixture only; default offline | suite-wide fetch guard (`test/setup.ts`), `test/offline-guard.cjs`, M15/M16 loopback tests, empty guard logs in acceptance runs | pass |
| 9 | No v0.3 milestone changes `package.json`, lockfile, `scripts/`, `.github/`, `.project/`, `PROJECT.md` or `ROADMAP.md`; `action-dist/index.cjs` current at every merge; CI green on `main` | M16 base-manifest scope test; `npm run check:action`; action artifact unchanged and reproducible. PR checks are reported on the PR; main CI awaits the owner-authorized merge. | base/main satisfied; M16 main CI pending owner merge |
| 10 | README documents annotations, outputs and unchanged CLI; release-tag statements match existing tags; release/tag decision handed to owner | `test/m16-readme-contract.test.ts`, updated M8 README contract test, tag inventory above, this report | pass; decision pending owner |

## Verification gates

All commands run under Node 22 from the isolated worktree:

| Command | Result |
| --- | --- |
| `npm ci` | pass |
| `npm test` | pass, 1261 tests in 50 files |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run build:action` | pass; byte-identical artifact |
| `npm run check:action` | pass; “action entrypoint is reproducible” |
| `npm ls --omit=dev` | empty production dependency tree |
| M16 focused suites | pass (9 + 43 + 13 + 15 named tests) |

The checked-in artifact is current, rebuilds byte for byte, leaves no diff, and
the stale-artifact rejection test still fails a deliberately modified copy. The
artifact contains no absolute worktree path or build timestamp. The separate
consumer-workspace test runs the committed artifact from a directory that
contains only `action.yml` and `action-dist/index.cjs`, with no `node_modules`
and no TypeScript build.

## Multi-file v0.3 fixture

`test/fixtures/m16-multifile/` is repository-contained and non-confidential: four
Markdown files plus a valid image. It covers valid and broken file links, valid
and broken images, same-file and cross-file heading anchors, duplicate headings,
explicit `<a id>`/`<a name>` anchors, supported raw HTML links and images,
reference-style targets, skipped external occurrences, loopback external success,
loopback terminal failure and duplicate external occurrences. The frozen
expectation is 4 files checked, 16 local findings and 4 skipped external
occurrences; the loopback variant adds 2 broken external occurrences for 18
findings. A small loopback rewrite substitutes only the example origin, so no
test contacts a real host.

The suite proves that structured findings contain every broken target; text and
JSON membership and order agree; the action emits exactly one annotation per
finding in result order; output counts equal the structured summary; the direct
CLI emits no workflow command or action output; the default action performs no
fetch; external tests use loopback only; clean/broken/usage exits are 0/1/2;
retries do not create intermediate annotations; and request-completion order
does not affect result order. `test/m16-v03-fixture.test.ts`,
`test/m16-cli-action-contract.test.ts` and `test/m16-artifact-scope.test.ts` hold
the M16 assertions.

## Real-docs snapshot verification

Snapshot: the root-owned read-only copy named
`/opt/dsh-factory/snapshots/dsh-copilot@fc98b7b953f59f4e747d14164119770f1777e96d/`.

| Property | Observation |
| --- | --- |
| Exists | yes, readable directory |
| Effective revision | `fc98b7b953f59f4e747d14164119770f1777e96d`, encoded in the directory name |
| Git metadata | absent (`.git` missing); the revision cannot be independently re-verified from Git, and no fetch/substitution was attempted |
| Ownership / mode | `root:root`, `755`; the run user cannot write |
| Symlink | no; resolves to itself |
| Files / directories / symlinks | 154 files, 12 directories, 0 symlinks |
| Markdown files | 18 |
| Initial tracked/untracked state | no Git metadata; equivalent full-tree inventories recorded instead |
| Initial inventory fingerprint (SHA-256 of the sorted inventory) | `329a8be7d8450a82cae79a9f1976e6a93e6f9ce6a1ef8b3d9910f0b6336002c6` |

The snapshot is not a Git checkout, so the spec’s “when Git metadata permits
verification” clause applies: its revision is verified from the exact required
path name, not from `.git`. This is a recorded limitation, not a substitution.

Inventories captured before and after **every** run include path, type, size,
mtime, permission mode, owner/group, symlinks and SHA-256 of every file. All 6
run pairs are byte-identical, so the runs made no tracked modification, created
no untracked file, changed no content, created no cache/lock/report/temp file and
changed no ownership or permission.

## Real-docs commands and results

All runs used the exact snapshot as the working directory, the product build
from the reviewed head, Node `v22.23.4`, and `test/offline-guard.cjs` preloaded.
The guard records and refuses `fetch`, `http(s).request`, `net.connect`,
`tls.connect`, DNS lookups, sockets and any filesystem access beneath the
external cache root. A positive control (`--external` against a loopback
unreachable port) produced 3 guard entries, proving the guard is live; the six
acceptance runs produced **zero** entries.

Commands (paths abbreviated; all evidence stored outside the checked repository):

```text
cd <snapshot>
node --require <repo>/test/offline-guard.cjs <repo>/dist/cli.js .
node --require <repo>/test/offline-guard.cjs <repo>/dist/cli.js --json .
env INPUT_PATHS=. INPUT_EXTERNAL=false GITHUB_OUTPUT=<evidence>/action-N.GITHUB_OUTPUT \
  node --require <repo>/test/offline-guard.cjs <repo>/action-dist/index.cjs
```

| Run | Exit | Files checked | Broken | External skipped | Stderr | Guard entries | Inventory identical |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CLI text 1 | 1 | 18 | 2 | 0 | empty | 0 | yes |
| CLI text 2 | 1 | 18 | 2 | 0 | empty | 0 | yes |
| CLI JSON 1 | 1 | 18 | 2 | 0 | empty | 0 | yes |
| CLI JSON 2 | 1 | 18 | 2 | 0 | empty | 0 | yes |
| Action wrapper 1 | 1 | 18 | 2 | 0 | empty | 0 | yes |
| Action wrapper 2 | 1 | 18 | 2 | 0 | empty | 0 | yes |

CLI text output:

```text
HANDOVER-ADCP.md:5: ../../AGENTS.md — target does not exist
docs/plan/foreman-v0.1-plan.md:120: url — target does not exist
Checked 18 files: 2 broken targets, 0 external links skipped.
```

Repeated runs were identical after comparison of diagnostics, paths, lines,
targets, reasons, ordering, counts, annotations, outputs and exits; nothing was
normalized away. Action output records:

```text
files-checked=18
broken=2
external-skipped=0
```

The two wrapper runs emitted exactly two annotations, in the same order as the
JSON diagnostics, after the unchanged CLI text:

```text
::error file=HANDOVER-ADCP.md,line=5::../../AGENTS.md — target does not exist
::error file=docs/plan/foreman-v0.1-plan.md,line=120::url — target does not exist
```

The direct CLI wrote no annotation and no action output, and no cache was read
or written. `summary.externalSkipped` is `0` and the action’s
`external-skipped` output is `0`, matching the snapshot, which contains no
counted external occurrences in its 18 Markdown files. The action did not create
a cache in the snapshot or anywhere under the checked repository.

## Diagnostic-classification ledger

Every reported local diagnostic has exactly one classification and direct
filesystem evidence. No `TOOL_FALSE_POSITIVE`, `UNSUPPORTED_DOCUMENTED_FORM` or
`AMBIGUOUS_OWNER_REVIEW_REQUIRED` entry was found, so no production fix or
fixture reduction was needed.

| ID | Path:line (column) | Target | Reason | Syntax | Resolved target | Direct evidence | Classification | Conclusion / follow-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M16-REAL-1 | `HANDOVER-ADCP.md:5` (17) | `../../AGENTS.md` | target does not exist | inline Markdown link | `<snapshot>/../../AGENTS.md`, i.e. `/opt/dsh-factory/AGENTS.md` | the target file is absent; `find` found no `AGENTS.md` in the snapshot root or within three levels of `/opt/dsh-factory` | `REAL_BROKEN_LOCAL_LINK` | the link resolves outside the snapshot and its target does not exist; a real broken link in the owner’s document, not a product defect. The snapshot is read-only and owner-owned, so no document fix is made. |
| M16-REAL-2 | `docs/plan/foreman-v0.1-plan.md:120` (214) | `url` | target does not exist | inline Markdown link (literal `[PR #N](url)` template in prose) | `<snapshot>/docs/plan/url` | the target path does not exist; no file named `url` exists under `docs/plan/` | `REAL_BROKEN_LOCAL_LINK` | placeholder links written as ordinary Markdown are documented as checked targets; the tool correctly reports a real broken link. Not a false positive; the fix belongs to the owner’s document. |

The complete per-run evidence and the machine-readable ledger are kept outside
the repository; the ledger’s summary did not contain credentials or private
content.

## Changed paths and scope

`git diff --name-only 4c821d201072b3fe00ebd053605e95cf7d5e8a93...HEAD` (reviewed
head) lists only:

- `README.md`
- `docs/m16-acceptance.md`
- `test/m16-base-manifest.json`
- `test/m16-artifact-scope.test.ts`
- `test/m16-cli-action-contract.test.ts`
- `test/m16-helpers.ts`
- `test/m16-readme-contract.test.ts`
- `test/m16-v03-fixture.test.ts`
- `test/fixtures/m16-multifile/` (4 Markdown files and 1 empty PNG)
- `test/m14-exit-usage-interaction.test.ts` (adds the M16 paths to the M14-era later-milestone allowlist)
- `test/readme-contract.test.ts` (tag-truthfulness assertions)

Every path is within the M16 allowlist (`src/**`, `test/**`, `docs/**`,
`README.md`, `action.yml`, `action-dist/index.cjs`). No `.github/` or `.project/`
path changed; no workflow, tag, release or npm publication was created. The
committed base manifest (`test/m16-base-manifest.json`, generated from the
authorized base) lets the scope test work in a shallow CI checkout without
fetching history.

## Required named-test mapping

Tests are listed by their exact required name where M16 adds it; equivalent
existing coverage is named for reuse rather than duplication.

### Multi-file regression — `test/m16-v03-fixture.test.ts`

`v0.3 fixture checks several Markdown files`; `v0.3 fixture reports several
findings`; `v0.3 fixture reports broken files images and anchors`; `v0.3 fixture
combines Markdown and supported raw HTML`; `v0.3 fixture combines local and
external results`; `v0.3 fixture preserves deterministic result order`; `v0.3
fixture text JSON annotations and outputs agree`; `v0.3 fixture preserves
duplicate occurrence behavior`; `v0.3 fixture remains deterministic across
repeated runs`.

### CLI compatibility — `test/m16-cli-action-contract.test.ts`

`v0.3 direct CLI text is unchanged`; `v0.3 direct CLI JSON is unchanged`; `v0.3
direct CLI exits remain 0 1 and 2`; `v0.3 direct CLI emits no workflow command`;
`v0.3 direct CLI writes no action output`; `v0.3 direct CLI remains offline by
default`.

### Annotations and outputs

- `v0.3 action emits one annotation per broken finding` — M16 test
- `v0.3 annotations include file line target and reason` — M16 test
- `v0.3 annotation order matches structured result order` — M16 test; also
  `test/m12-action-annotations.test.ts`: `multiple action findings preserve result order`
- `v0.3 clean run emits no annotation` — M16 test; `test/m12-action-annotations.test.ts`: `clean action run emits no annotation`
- `v0.3 usage error emits no broken-link annotation` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `usage error emits no broken-link annotation`
- `v0.3 skipped external occurrences emit no annotation` — M16 test; `test/m12-action-annotations.test.ts`: `default skipped external target emits no annotation`
- `v0.3 terminal external failures emit annotations` — M16 test; `test/m15-external-failures.test.ts`: `terminal external HTTP failure emits one annotation`
- `v0.3 annotation values remain safely escaped and bounded` — M16 test; `test/m11-annotation-values.test.ts` (94 tests) and `test/m12-action-annotations.test.ts` special-value tests
- `v0.3 clean run publishes every documented output` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `clean result publishes every documented output`
- `v0.3 broken run publishes every documented output` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `broken result publishes every documented output`
- `v0.3 offline run publishes established skipped counts` — M16 test; `test/m15-default-offline.test.ts`: `default outputs match the established skipped-external summary`
- `v0.3 external run publishes established checked counts` — M16 test; `test/m15-external-enabled.test.ts`: `successful external check publishes established counts`
- `v0.3 output values match structured summaries` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `broken action outputs match the structured summary`
- `v0.3 output names match action metadata` — M16 test; `test/m13-action-outputs.test.ts` and `test/m15-metadata-scope.test.ts`
- `v0.3 output environment-file encoding remains valid` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `output environment-file encoding remains valid`
- `v0.3 adds removes and renames no established output` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `M14 removes no output`, `M14 renames no output`, `M14 adds no output`

### Exits, modes and mutation guards

- `v0.3 clean action exits 0` — M16 test; `test/m15-mixed-usage.test.ts`: `clean offline action exits 0`
- `v0.3 broken action exits 1` — M16 test; `test/m15-default-offline.test.ts`: `default skipped external target does not cause exit 1` and M14 broken tests
- `v0.3 usage error exits 2` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `usage-error action exits 2 while annotations and outputs are active`
- `v0.3 annotations do not determine the exit` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `annotation count does not determine exit status`
- `v0.3 outputs do not determine the exit` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `summary output values do not determine exit status`
- `v0.3 broken exit retains annotations and outputs` — M16 test
- `v0.3 diagnostic text remains unchanged` — M16 test
- `v0.3 usage text remains unchanged` — M16 test; `test/m14-exit-usage-interaction.test.ts`: `usage text is byte-for-byte unchanged`
- `v0.3 default action performs no fetch` — M16 test; `test/m15-default-offline.test.ts`: `default action mode performs no fetch`
- `v0.3 default action performs no DNS or socket access` — M16 test; `test/m15-committed-artifact.test.ts`: `default mode performs no DNS or socket access`
- `v0.3 default action does not access the external cache` — M16 test; `test/m15-committed-artifact.test.ts`: `default mode does not read or write the external cache`
- `v0.3 external tests use loopback only` — M16 test; `test/m15-external-enabled.test.ts`: `external tests bind only to loopback`, `external tests perform no public DNS lookup`
- `v0.3 external success remains clean` — M16 test; `test/m15-external-enabled.test.ts`: `successful external check exits 0 when local targets are clean`
- `v0.3 terminal external failure exits 1` — M16 test; `test/m15-external-failures.test.ts`: `terminal external HTTP failure exits 1`
- `v0.3 retry success produces no final annotation` — M16 test; `test/m15-external-failures.test.ts`: `intermediate retry failures do not produce annotations`
- `v0.3 retry exhaustion produces one final finding per occurrence` — M16 test; `test/m15-occurrence-cache.test.ts`: `duplicate failed occurrences produce one annotation per occurrence`
- `v0.3 request completion order does not change annotation order` — `test/m15-occurrence-cache.test.ts`: `request completion order does not change annotation order`
- `v0.3 external cache tests use isolated temporary paths` — M16 test; `test/m15-occurrence-cache.test.ts`: `cache tests use temporary isolated paths`
- `checking a read-only fixture creates no file` — M16 test
- `checking a read-only fixture modifies no file` — M16 test
- `offline action checking creates no cache in the checked repository` — M16 test
- `CLI output is written only to configured process streams` — M16 test
- `action outputs are written only to configured GITHUB_OUTPUT file` — M16 test
- `acceptance evidence is stored outside the checked repository` — M16 test

### README contract — `test/m16-readme-contract.test.ts`

`README documents v0.3 annotations`; `README documents every action output`;
`README states direct CLI output is unchanged`; `README documents exits 0 1 and
2`; `README documents offline default and external opt-in`; `README action inputs
match action metadata`; `README output names match action metadata`; `README
release-tag statements match tags that exist`; `README uses a placeholder when no
applicable release tag exists`; `README does not claim npm publication`; `README
retains release and tag decisions for the owner`.

### Artifact and scope — `test/m16-artifact-scope.test.ts`

`v0.3 checked-in artifact handles the multi-file fixture`; `v0.3 checked-in
artifact emits expected annotations and outputs`; `v0.3 checked-in artifact
default mode performs no fetch`; `v0.3 checked-in artifact works from a separate
consumer workspace`; `v0.3 checked-in action artifact is current`; `v0.3 action
entrypoint rebuild is byte reproducible`; `v0.3 action reproducibility check
leaves no diff`; `v0.3 stale action artifact is rejected`; `v0.3 changes only
permitted paths`; `v0.3 changes no path under github metadata`; `v0.3 changes no
path under project metadata`; `v0.3 adds no workflow`; `v0.3 retains zero runtime
dependencies`; `v0.3 creates no tag release or npm publication`.

### Reused M9–M15 coverage

The structured-finding contract (`test/m9-*`), annotation formatter and safe
values (`test/m11-*`), action annotation/exits/outputs integration
(`test/m12-*`), summary outputs (`test/m13-*`), exit/usage interaction
(`test/m14-*`) and offline/external interaction matrix (`test/m15-*`) are reused
unchanged rather than duplicated. The M9–M15 fixture suites remain green.

## CI, merge, release and tag status

```text
PR checks: green for the final reviewed head (see the pull request check suite)
Merge authority: owner; this agent does not merge and does not enable auto-merge
Merged main commit: none yet
Main CI after merge: pending owner-authorized merge
Release decision: pending owner
Tag decision: pending owner; no v0.3 tag was created
```

CI is never described as green on `main` here: the feature-branch checks and the
local gates are the evidence, and main CI can only be verified after the owner
merges. The repository’s CI job runs type-check and the full test suite under
Node 22 on the pull request.

## Residual risks and unresolved facts

- The snapshot has no Git metadata; its revision is verified from the exact
  required directory name only. No fetch or substitute checkout was used.
- The snapshot is the owner’s document tree; its two real broken links are not
  fixed here because the snapshot is read-only and outside this repository. They
  are not product defects.
- The real-docs acceptance was run offline by requirement, so external targets
  in the snapshot were skipped; the snapshot contained no counted external
  occurrences under the checker’s rules.
- The v0.3 tag and release decisions remain with the owner. The README contract
  test intentionally fails if a future v0.3 tag is created without updating the
  documented tag statements.
- The M16 changed-line total is reported by the factory gate; the packet is one
  focused PR of tests, documentation and this report, with no production code
  change.
