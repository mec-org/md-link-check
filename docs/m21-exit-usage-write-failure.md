# M21 — Exit, usage and write-failure interaction

Base: `050a8251c56fab1b739347e6087be29898b6b524` (M20, #54).

M21 hardens the interaction between the action's established result and the job
summary. The summary is always secondary: a clean run still exits `0`, a broken
run still exits `1`, and a usage or action-input error still exits `2`. A usable
`GITHUB_STEP_SUMMARY` gets exactly one summary; an unset, empty or unwritable
destination appends nothing, emits exactly one warning, and changes nothing
else.

## Authoritative exit matrix

| Outcome | Exit | Summary content when a destination is usable | Otherwise |
| --- | --- | --- | --- |
| Clean completed check | `0` | One M19 run summary | No write; one warning |
| Broken completed check | `1` | One M19 run summary | No write; one warning |
| Usage or action-input error | `2` | One fixed usage-error fragment | No write; one warning |

The exit code is authoritative throughout. Capturing it never depends on the
summary, and a summary success or failure cannot turn `0` into `1`/`2`, `1`
into `0`/`2`, or `2` into `0`/`1`. The CLI-owned bytes are the same with and
without a summary destination apart from the M21 warning line described below.

## Control-flow point

`src/run.ts` now returns an additive `RunResult.outcome`
(`'checked' | 'help' | 'usage-error' | 'internal-error'`). It is derived from
the same invocation that produced the exit code and the structured summary; it
is never parsed out of printed text. `src/action-runner.ts` uses it once, after
`run(...)` has returned:

1. the CLI's diagnostics and its own summary are already written;
2. `emitAnnotations` writes the workflow-command annotations, unchanged;
3. `publishSummaryOutputs` writes the three counts for a completed check,
   unchanged;
4. `writeStepSummary` performs the final action publication for the invocation.

Because the exit code is returned from the same result object and every
established publication happens before step 4, a summary failure cannot bypass
or replace them. An action-input error takes the equivalent early path: the
unchanged usage diagnostic is written, then the one summary handling call runs,
then exit `2` is returned.

`RunResult.outcome` is an internal seam for the bundled action. The CLI's text
and `--json` output do not expose it, and direct CLI execution does not import
the action modules.

## Usage-error summary

A run that never started has no authoritative `filesChecked`, `broken` or
`externalSkipped` counts, and M19's formatter requires a count list that
describes a completed check. M21 therefore adds a separate, pure formatter,
`formatUsageErrorSummaryMarkdown` in `src/summary-markdown.ts`. It renders this
exact Markdown fragment, including one final newline:

```text
## Results

- Outcome: usage error
- Link check: not performed
```

Properties frozen by tests:

- it is a complete fragment with exactly one diagnostic list entry count of
  zero: there is no `## Diagnostics` section and no broken-link entry;
- it fabricates no run counts; zero counts are not invented for a check that
  never happened;
- it explicitly identifies the usage outcome and states that no link check was
  performed;
- it does not copy the usage diagnostic into Markdown, so no raw usage text can
  alter the summary structure;
- it is deterministic, pure and I/O-free. The action path alone decides whether
  to write it.

M19's count guard stays authoritative for normal clean and broken runs: the
`completed` branch renders through `formatRunSummaryMarkdown` unchanged, its
mismatch error still escapes before any append, and M21 neither weakens nor
bypasses it. The usage formatter is a separate branch, not a forged M17 result.

## Warning channel, message and encoding

Warnings use the repository's established GitHub Actions workflow-command
mechanism. `formatWarningCommand` in `src/annotation.ts` reuses the existing
data-channel escaping (`%` → `%25`, CR → `%0D`, LF → `%0A`); no ad hoc
unescaped command is written. The fixed messages contain no special character,
so their exact encoded lines are:

```text
::warning::GITHUB_STEP_SUMMARY is not set; no job summary was written.
::warning::GITHUB_STEP_SUMMARY could not be written; no job summary was written.
```

- The first message covers both an unset variable and the empty string: neither
  names a usable file, so no filesystem access is attempted and the same stable
  message is used.
- The second covers a destination the runner supplied but the process could not
  append to. The raw filesystem error object, error code, path and secrets are
  never interpolated or dumped.
- No warning is emitted when the summary appends successfully.
- There is no second low-level warning: `appendStepSummary` returns a
  classification and prints nothing; only the single wrapper call site prints.
- Warnings go to standard output, the same stream the action already uses for
  workflow commands, each followed by exactly one newline.

Placement is the final action publication: after the unchanged CLI output, the
annotations and the output publication. For a usage error the warning is the
only stdout byte; the usage diagnostic on stderr is untouched. Tests freeze the
exact warning lines structurally and count them as complete lines.

## Destination behavior

- **Unset**: no formatting and no filesystem access; exactly one warning; the
  underlying exit and every pre-existing byte are unchanged.
- **Empty**: treated exactly like unset, per the repository's existing M20 rule
  that an absent or empty value is unavailable. No filesystem access, one
  warning, exit unchanged.
- **Writable**: one append with no separator; existing summary bytes are
  preserved; exactly one summary; no warning.
- **Unwritable**: exactly one append is attempted, its rejection is classified
  as a failure at the summary boundary (`appendStepSummary` returns `'failed'`)
  and turned into the one write-failed warning. The error does not propagate to
  the action entrypoint, does not create a second failure, is not retried, does
  not replace the diagnostic or usage text, and does not change the exit code.
  A deterministic missing-parent path is used for tests, not permission bits.

`writeStepSummary` is the single summary call site, so "exactly once" follows
from normal control flow; there is no module-global once-only flag. An
unavailable destination is warned about for every action outcome that reaches
summary handling (`checked`, `usage-error` and an internal `none` outcome). An
internal failure, which already reports its own error and exits `2`, has no
defined summary content: with a usable destination nothing is written, and with
an unavailable destination the one warning is still emitted. Errors thrown
before summary handling (for example an action-owned output-file failure) keep
their established internal-error behavior.

## Preserved surfaces

- Established usage text is byte-for-byte unchanged, including its stderr
  routing and final newline.
- Broken-link diagnostic text, workflow-command annotations and their order,
  and the three `files-checked`, `broken` and `external-skipped` outputs are
  byte-for-byte unchanged for normal runs.
- A usage error publishes no normal-run annotations or outputs, exactly as
  before M21.
- The summary itself is never printed to stdout or stderr.
- Direct CLI runs (`dist/cli.js`) never import the action modules, never read or
  alter `GITHUB_STEP_SUMMARY`, and never emit an action warning, even when the
  variable is absent, empty, writable or invalid.

## Tests

`test/m21-exit-summary-interaction.test.ts` runs the committed
`action-dist/index.cjs` bundle in a child process and covers the required
matrix:

1. `keeps exit zero when a clean summary is written`
2. `keeps exit one when a broken summary is written`
3. `keeps exit two and writes a diagnostic-free usage summary` — both an
   action-input error and a CLI usage error reached through the real action
   path; exact summary, no diagnostics, unchanged usage bytes
4. `warns once for an unset summary destination without changing exit zero`
5. `warns once for an unset summary destination without changing exit one`
6. `warns once for an unset summary destination without changing exit two`
7. `warns once for an empty summary destination`
8. `warns once for an unwritable summary destination without replacing the
   result` — broken and usage results; original exit and text preserved
9. `does not duplicate warnings when summary append fails` — low-level
   classification prints nothing and the action prints exactly one warning
10. `action-dist/index.cjs is current` — the repository's existing
    `scripts/build-action.mjs --check` proves the committed bundle equals a
    fresh build

`test/cli-summary-isolation.test.ts` adds
`direct CLI ignores absent empty and invalid summary destinations`, invoking the
built CLI directly and asserting no write, no warning and unchanged output and
exit for each case.

`test/action-summary-integration.test.ts` was updated where M21 legitimately
changes M20's behavior: absent and empty destinations now warn once instead of
staying silent, an unwritable destination now warns and preserves the completed
result instead of failing through the internal-error path, and a usage error now
writes the fixed usage summary. The M19 count guard test still proves that a
count/finding mismatch throws before any append and emits no warning.

The M9–M17 action suites that freeze unrelated printed surfaces now receive a
writable temporary summary from the shared test helper (the way a hosted runner
provides one), so their frozen bytes stay meaningful; the M21 tests opt into the
unavailable destinations explicitly.

## Bundle regeneration

```bash
npm run build:action   # regenerate action-dist/index.cjs
npm run check:action   # fail if the committed bundle is stale
```

`action-dist/index.cjs` is regenerated and committed because the runtime import
graph and the shipped action behavior changed. The bundle remains self-contained
with no runtime dependency.

## Verification

```bash
npm run typecheck
npm run build
npm test
npm run build:action
npm run check:action
node scripts/check-scope.mjs   # no .github/ or .project/ change
```

A full local checkout additionally exposes the same two pre-existing,
history-dependent failures recorded for M20 (the M14 authorized-base
permitted-path check sees the owner-approved v0.4 charter changes, and
`test/m16-artifact-scope.test.ts` sees the local `v0.3.0` tag). CI's shallow,
tag-less checkout skips both; M21 neither causes nor hides either one.

## Assumptions found false or resolved

- M20 treated an absent or empty destination as silently unavailable; M21
  changes that to exactly one warning, as the roadmap requires.
- M20 treated an unwritable destination as fatal through the action's
  internal-error path. M21 replaces that with one warning and the unchanged
  underlying result, because the summary is secondary.
- M20 wrote no summary for a usage error. M21 adds the separate zero-diagnostic
  usage fragment rather than forcing a fabricated M17 summary through the M19
  guard.
- The repository had no warning formatter. `src/annotation.ts` already owned
  the safe workflow-command data-channel escaping, so M21 adds one small
  `formatWarningCommand` there instead of a parallel escaping mechanism.
- The M17 structured result had no failure classification. An additive
  `RunResult.outcome` field lets the action choose the usage summary without
  parsing printed text or comparing error strings.
- M19's formatter cannot represent a run that never happened without inventing
  counts, so a narrowly scoped usage formatter was added next to it.
