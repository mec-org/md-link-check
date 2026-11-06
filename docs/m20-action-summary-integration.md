# M20 — Action summary integration

Base: `02127a78d1e72639a791d21bebb524c3d65cbc34` (M19 follow-ups, #52).

M20 wires the M19 formatter into the existing GitHub Action. After one normal
completed check, the action appends exactly one M19-formatted job summary to the
file the runner names in `GITHUB_STEP_SUMMARY`. The direct CLI, the annotations,
the action outputs and every exit code keep their existing bytes and meaning.

> **M21 supersedes this milestone's unavailable-destination policy.** An unset,
> empty or unwritable destination no longer stays silent or fails through the
> internal-error path: it emits exactly one warning and preserves the
> completed result. A usage error now appends the fixed zero-diagnostic usage
> summary. See `docs/m21-exit-usage-write-failure.md` for the current contract.

## Integration point

The only production integration edge is `runAction` in `src/action-runner.ts`,
which is the action-only orchestration layer. It calls one helper once:

```ts
const result = await run(buildCommandLine(inputs), io);
emitAnnotations(result.diagnostics, io);
if (result.summary !== null) {
  await publishSummaryOutputs(result.summary, environment);
  await writeStepSummary(result.summary, result.diagnostics, environment);
}
return result;
```

`writeStepSummary` is exported from `src/action-runner.ts` for focused tests. It
reads `GITHUB_STEP_SUMMARY` from the environment object the action already
receives, returns without formatting or writing when the value is absent or
empty, and otherwise calls `formatRunSummaryMarkdown(...)` and hands the
already-formatted Markdown to `appendStepSummary(...)` in
`src/action-step-summary.ts`. That helper owns only `appendFile`; it never
formats a summary, reads the environment, parses output or writes stdout or
stderr. `src/action.ts` is unchanged: a propagated summary failure reaches its
existing internal-error `catch`.

## Data flow

- The counts and findings are the authentic M17 result:
  `RunResult.summary` (`ActionSummary`) and `RunResult.diagnostics`
  (`readonly BrokenLinkResult[]`) from `src/run.ts`. M20 adds no parallel
  summary model and does not recompute, sort, mutate, deduplicate, regroup or
  reconstruct them.
- The object is passed directly to the existing M19
  `formatRunSummaryMarkdown(counts, diagnostics)` export from
  `src/summary-markdown.ts`. That formatter owns the grammar, the ordering, the
  50-diagnostic limit, the overflow disclosure and the M18
  `escapeSummaryValue` escaping; M20 changes none of them.
- M19's runtime count guard stays authoritative. `writeStepSummary` does not
  catch the formatter's `Error` and does not rewrite counts, so a
  `summary.broken`/diagnostics disagreement propagates instead of producing a
  contradicting summary. A focused test calls the seam with a mismatched pair
  and proves the deterministic error escapes and that no partial summary is
  written.

## Exactly-once append

- One completed check means one `runAction` invocation, and the one
  `writeStepSummary` call above is the only summary write in the action path.
  There is no module-global state and no second call site, so "exactly once"
  follows from the normal control flow.
- `GITHUB_STEP_SUMMARY` is read from the environment argument the action
  receives, not from unrelated global state. An absent value or the empty string
  is unavailable: no formatting and no write happen.
- A usage, input or internal failure returns before a valid M17 result exists
  (`summary === null`), so no summary is written for it. There is no summary for
  an action-input error, a discovery error or any other pre-check failure.
- The write uses Node's built-in `fs/promises.appendFile`, so every pre-existing
  byte is preserved. Nothing is printed to stdout or stderr, and no workflow
  command is reordered.

## Separator and final newline

M20 inserts **no separator**. The M19 formatter returns a complete fragment that
starts with the `## Results` heading and always ends with exactly one newline;
that fragment is appended byte-for-byte after any existing content. The writer
adds no leading blank line, no trailing newline and no other bytes of its own.

Consequences, frozen by tests:

- when the existing file ends with a newline, its bytes are unchanged and the
  summary heading starts on the next line;
- when the existing file does not end with a newline, its bytes are still
  unchanged and the heading immediately follows those bytes. M20 never rewrites
  pre-existing content to add a newline.

## Unusable destination policy (superseded by M21)

M20 originally followed the M13 `GITHUB_OUTPUT` precedent and made an
unwritable summary destination fatal through the entrypoint's internal-error
path. M21 supersedes that policy: summary handling is secondary, an unset or
empty destination emits one warning without any filesystem access, and an
unwritable destination emits one warning and keeps the completed check's
`0`/`1` (or usage error's `2`). The append classification lives in
`src/action-step-summary.ts`; the warning and the final publication live in
`src/action-runner.ts`. See `docs/m21-exit-usage-write-failure.md` for the
current exact messages, placement and tests.

## Unchanged surfaces

- CLI text and `--json` output are byte-for-byte unchanged; the summary is
  appended to a file and never printed.
- Workflow-command annotations are unchanged in bytes and order.
- The three `files-checked`, `broken` and `external-skipped` outputs are
  unchanged in bytes and order.
- Clean and broken action exits stay `0` and `1`; usage and internal failures
  stay `2`, including a summary append failure.
- Direct CLI execution never imports the action modules and never reads or
  alters `GITHUB_STEP_SUMMARY`, even when the variable is set. JSON mode is
  equally isolated.

## Scope guard

`test/m19-scope.test.ts` was the M19 guard that required the formatter to be
unreachable from every other production module and the committed bundle to be
the pre-summary v0.3 bundle; its docstring anticipated that M20 would update it.
M20 updates only the precise integration edge:

- `src/action-runner.ts` is the only production module allowed to import or
  mention the M19 formatter and `GITHUB_STEP_SUMMARY`;
- `src/summary-markdown.ts` stays pure and imports no filesystem or environment;
- `src/action-step-summary.ts` stays formatter-free;
- the committed bundle contains the M20 integration, so the shipped artifact
  actually carries the formatter and the append path. Bundle freshness is proven
  positively, without a hand-maintained generated hash: the in-packet
  `action-dist/index.cjs is current` test runs the existing
  `scripts/build-action.mjs --check`, and the established
  `test/m15-committed-artifact.test.ts` and
  `test/m16-artifact-scope.test.ts` checks remain. No competing build mechanism
  is added.

The M9 and M17 suites contained the old absence assertions ("writes no step
summary") because those milestones predate the summary. M20 is the milestone
that adds it, so those two assertions now prove the opposite direction: the new
summary is appended while every frozen M9/M17 structured-result and surface byte
stays unchanged. No byte-level, order or error assertion was weakened.

## Tests

`test/action-summary-integration.test.ts`:

1. `appends exactly one summary for a clean action run` — committed action
   bundle, temporary empty summary file, exact hard-coded Markdown, exactly one
   occurrence, unchanged text output, annotations (none), outputs and exit `0`.
2. `appends exactly one summary for a broken action run` — exact hard-coded
   Markdown with the diagnostics in result order and M18 escaping, unchanged
   text/annotations/outputs and exit `1`.
3. `formats the authentic M17 result through the guarded M19 formatter` —
   in-process `runAction` result compared with the formatter output for the same
   object, proving the counts are not rewritten.
4. `keeps the M19 count guard authoritative and writes nothing on mismatch` —
   the seam rejects a mismatched pair and leaves the existing file untouched.
5. `preserves existing summary bytes when appending` — a seeded prefix is
   byte-for-byte unchanged, one complete summary follows under the no-separator
   rule, including a seed that does not end with a newline.
6. `does not write when GITHUB_STEP_SUMMARY is absent` — otherwise identical
   output, stderr, exit and outputs compared with a writing run.
7. `does not write when GITHUB_STEP_SUMMARY is empty` — the empty string is
   unavailable; behavior matches the absent run.
8. `handles an unusable summary destination under the established action I/O
   policy` — missing parent directory: exit `2`, exact internal-error stderr,
   unchanged stdout, annotations and outputs, no stack trace, no warning, no
   file.
9. `writes no summary when no completed check produced a result` — input and
   discovery failures leave both the summary file and the output file empty.
10. `limits the action summary to fifty diagnostics with the overflow
    disclosure` — a 52-finding action run lists the first 50 in result order,
    omits the last two values, and renders the exact `52 total diagnostics; 2
    not listed.` disclosure with the authentic `Broken: 52` count.
11. `action-dist/index.cjs is current` — rebuilds the bundle through the
    repository's established `scripts/build-action.mjs --check` command and
    requires byte equality with the committed `action-dist/index.cjs`.

`test/cli-summary-isolation.test.ts`:

12. `direct CLI execution does not alter GITHUB_STEP_SUMMARY` — clean, broken
    and `--json` direct CLI runs over a seeded summary file leave it
    byte-for-byte unchanged and keep normal output and exits. The `--json`
    stdout bytes are also compared with the same run without the variable and
    asserted structurally.
13. `direct CLI sources do not reference the action summary writer` — the built
    CLI modules contain no summary or action reference.

The in-packet `action-dist/index.cjs is current` test reuses the existing
build script's `--check` mode; `test/m15-committed-artifact.test.ts` and
`test/m16-artifact-scope.test.ts` keep their established freshness and
reproducibility coverage, so M20 adds no competing build mechanism.

Files updated for the integration, listed here rather than only in the PR:

- `test/action-helpers.ts`, `test/m15-helpers.ts` and
  `test/m12-action-annotations.test.ts`: action children started by these
  helpers and tests now delete the host `GITHUB_STEP_SUMMARY` (as they already
  did for `GITHUB_OUTPUT`), so the suite never appends to a runner's own
  job-summary file while the M20 tests opt in explicitly with temporary paths.
- `test/m14-exit-usage-interaction.test.ts`: adds only the M20 paths to the
  later-milestone allowlist, exactly as earlier milestones did. It does not
  exempt, skip or widen any pre-existing path; the pre-existing full-checkout
  charter-file failure described under Verification remains outside M20 and is
  not hidden by this PR.
- `test/m17-v03-surface-regression.test.ts` and
  `test/m9-action-result.test.ts`: the superseded "writes no step summary"
  absence assertions now prove the summary is appended while every frozen
  M9/M17 structured-result and surface byte stays unchanged.
- `test/m19-scope.test.ts`: the M19 guard is narrowed to the single permitted
  integration edge and its bundle assertions, as described under Scope guard.

## Bundle regeneration

```bash
npm run build:action   # regenerate action-dist/index.cjs
npm run check:action   # fail if the committed bundle is stale
```

M20 regenerates and commits `action-dist/index.cjs` because it adds runtime
modules to the action entrypoint's import graph. The bundle remains
self-contained and adds no runtime dependency.

## Verification

Checks run for this milestone:

```bash
npm run typecheck      # tsc --noEmit
npm test               # pretest build + full Vitest suite
npm run build:action   # regenerate action-dist/index.cjs
npm run check:action   # bundled action is current and reproducible
node scripts/check-scope.mjs   # no .github/ or .project/ change
```

All M20 tests, the M18/M19 formatter suites, the M17 fixture provenance and
surface suites, the M16 artifact/scope suites and the M9–M15 action suites pass
in the repository's standard check environment: GitHub Actions `CI`
(`.github/workflows/ci.yml`, `pull_request` trigger: `npm run typecheck` and
`npm test` on a Linux shallow checkout) plus the repository's CodeQL workflow.
The live check runs and a locally reproduced CI-equivalent run are recorded
under "CI evidence" below.

The standard environment is a shallow checkout; a full local checkout
additionally has every base commit and live tag. That difference exposes two
pre-existing, environment-dependent failures that are outside M20:

- `test/m14-exit-usage-interaction.test.ts` "M14 changes only permitted paths
  relative to the authorized base" runs only when its authorized base
  `be1c580` is present, so CI skips it and a full local checkout runs it. It
  fails because the owner-approved v0.4 charter PR #44 changed `PROJECT.md` and
  `ROADMAP.md` after M14's base. M20 changes neither file and does not exempt,
  skip or allowlist either path: those two files still fail the M14 permitted-
  path check exactly as they did at the authorized base. Repairing that
  pre-existing guard belongs to a separate, owner-approved change, not to M20.
- `test/m16-artifact-scope.test.ts` "v0.3 creates no tag release or npm
  publication" requires that no `v0.3*` tag exists in the local checkout. A
  full local clone carries the `v0.3.0` tag created for the M17 fixture
  provenance, while the CI checkout fetches no tags and the test passes there.
  This failure is identical at the authorized base `02127a7` and is unrelated
  to M20.

Full local checkout at the reviewed head, with the M14 base commit and live
tags available (`npm test`): **1317 passed, 2 failed, 1319 total**. The two
failures are exactly the pre-existing M14 charter-file and M16 local-tag
assertions above; M20 neither causes nor hides either one.

Other checks: `npm run check:action` reports
`action entrypoint is reproducible: action-dist/index.cjs`, and
`node scripts/check-scope.mjs` reports no change under `.github/` or
`.project/`.

## CI evidence

Recorded for the reviewed code head
`ce099e21c6cc1df57e6f7155b3c21f6eaf123d4d`; the final documentation-only commit
on this branch changes no code, test or bundle byte.

**CI-equivalent reproduction** — the repository-standard checkout condition
reproduced locally. The clone is one commit deep, fetches no tags and has no M14
base commit, matching `.github/workflows/ci.yml`:

```bash
git clone --depth 1 --no-tags \
  --branch agent/action-summary-integration-ec54ced0cb85 \
  https://github.com/mec-org/md-link-check.git
# HEAD=ce099e21c6cc1df57e6f7155b3c21f6eaf123d4d
# tags=0, base be1c580 unavailable
npm ci --ignore-scripts
npm run typecheck   # pass
npm test            # Test Files 57 passed (57)
                    # Tests 1316 passed | 3 skipped (1319)
```

**Live GitHub Actions checks** at `ce099e2` — 4/4 success:

- `test` — [CI run 42179886646 / job 127766794972](https://github.com/mec-org/md-link-check/actions/runs/42179886646/job/127766794972), pass.
- `Analyze (actions)` — [run 42179880030 / job 127766779823](https://github.com/mec-org/md-link-check/actions/runs/42179880030/job/127766779823), pass.
- `Analyze (javascript-typescript)` — [run 42179880030 / job 127766780133](https://github.com/mec-org/md-link-check/actions/runs/42179880030/job/127766780133), pass.
- `CodeQL` — [run 127766932937](https://github.com/mec-org/md-link-check/runs/127766932937), pass.

## Assumptions found false or resolved

- The M17 structured result *is* available after a normal action run as
  `RunResult.summary` and `RunResult.diagnostics`; no refactor or output parsing
  was needed.
- The M19 formatter *is* exported from `src/summary-markdown.ts` as
  `formatRunSummaryMarkdown` together with `SUMMARY_DIAGNOSTIC_LIMIT`; M20 reuses
  them unchanged.
- There was no centralized action-owned environment-file helper. The
  `GITHUB_OUTPUT` publisher is a separate module, so M20 adds one small
  action-only append helper rather than generalizing or changing the output
  publisher.
- Repository policy for action-owned environment-file write failures is fatal
  through the entrypoint's internal-error path (not warning-only or
  best-effort), as recorded in `src/action-outputs.ts` and its M14 tests; the
  summary append follows that precedent.
- M19 returns a complete fragment with exactly one trailing newline and no
  leading separator, so the append needs no separator of its own.
- `test/m19-scope.test.ts` did prohibit every action import of the formatter
  pending M20; M20 narrows it to the single intended integration edge instead of
  removing it.
- M9 and M17 contain stale "no job summary" absence assertions that this
  milestone necessarily supersedes; they are updated to prove the summary is
  added without changing their frozen surfaces.
