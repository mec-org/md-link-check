# M17 — Run-summary contract

Base: `2093d1716358f9784ae2c40c2d6c97171c91d3fe` (the v0.4 charter, #44).

M17 preserves and freezes the in-process run result that the GitHub Action
already receives. It adds no job summary; M20 appends the summary later.

## In-process seam

`src/run.ts` exposes one structured result for an invocation:

```ts
interface RunResult {
  readonly exitCode: 0 | 1 | 2;
  readonly diagnostics: readonly BrokenLinkResult[]; // ordered findings
  readonly summary: ActionSummary | null;            // null when no check completed
}

interface BrokenLinkResult {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly reason: string;
}

interface ActionSummary {
  readonly filesChecked: number;
  readonly broken: number;
  readonly externalSkipped: number;
}
```

`run(args, io, options)` projects the checker's diagnostics and counts once,
without re-sorting or re-parsing. `diagnostics` keeps the checker's existing
result order, which is also the CLI text and JSON order, and each value is a
lossless copy of the source finding's file, one-based line, target and reason.
`summary` is the authoritative completed-check summary, or `null` for a help,
usage-error or internal-error run.

`runAction(environment, io)` in `src/action-runner.ts` calls that seam and
returns the same `RunResult` after rendering one annotation per finding and
publishing the three `GITHUB_OUTPUT` records from it. Neither consumer parses
stdout, stderr, JSON output, annotation text or the exit code to recover the
counts or findings. `src/action.ts` only maps `exitCode` onto the process.

A later job-summary writer can consume `result.summary` and
`result.diagnostics` directly. No second result model is needed.

## Frozen v0.3 surface

The fixture is the committed `test/fixtures/m16-multifile` tree: four Markdown
files, 16 broken findings across several lines, file/image/anchor targets, two
reason kinds, and four skipped external uses. `test/m16-helpers.ts` is the
independent finding oracle.

Expected bytes are checked in under `test/fixtures/m17-v03/`:

- `cli-text.stdout.txt` — human-readable CLI stdout;
- `cli-json.stdout.txt` — `--json` CLI stdout;
- `action-annotations.txt` — workflow-command annotations, one per finding, in
  result order;
- `action-outputs.txt` — the three summary-count records, in order;
- `special-annotations.txt` — action annotations for the M11 special-values
  fixture, covering the property and message escapes;
- `edge-annotations.txt` — formatter-boundary annotations covering CR/LF and
  colon escaping plus the file, target, reason and message truncation bounds;
- `cli-usage.stderr.txt`, `action-input-error.stderr.txt` — frozen stdout/stderr
  routing for usage errors;
- `manifest.json` — the tag provenance and a SHA-256 for every file above.

`manifest.json` records tag `v0.3.0`, its tag object and commit
(`4438906e6e6085c941faf3117c2aaca1824a073d`), the tagged
`action-dist/index.cjs` SHA-256, and the capture command. The tag commit and the
M17 base (`2093d1716358f9784ae2c40c2d6c97171c91d3fe`) do not differ for `src/`,
`action-dist/index.cjs` or `action.yml`;
`git diff v0.3.0 2093d171 -- src action-dist/index.cjs action.yml` is empty.
`test/m17-capture-fixtures.mjs` reproduces every end-to-end expected file from a
built v0.3.0 checkout, and a provenance test verifies every file's size and
SHA-256 against the manifest.

The tests are:

- `test/m17-run-summary-contract.test.ts` — the wrapper receives all three
  counts and every finding with file, line, target and reason, in canonical
  order, through the structured seam rather than printed output;
- `test/m17-v03-surface-regression.test.ts` — text, JSON, normal annotations,
  escaping/truncation annotations, outputs, exit behavior, stdout/stderr
  routing and the absence of a job summary are byte-for-byte the frozen v0.3
  bytes;
- `test/m15-committed-artifact.test.ts` — the M17 test added there rebuilds
  `action-dist/index.cjs` from current source and requires byte equality with
  the committed bundle; the existing freshness and reproducibility tests remain.

## Deliberately absent

M17 writes no GitHub Actions job summary, adds no escaping or list formatter,
changes no CLI, annotation or output byte, and adds no runtime dependency.
