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
- `action-outputs.txt` — the three summary-count records, in order.

The tests are:

- `test/m17-run-summary-contract.test.ts` — the wrapper receives all three
  counts and every finding with file, line, target and reason, in canonical
  order, through the structured seam rather than printed output;
- `test/m17-v03-surface-regression.test.ts` — text, JSON, annotations and
  outputs are byte-for-byte the frozen v0.3 bytes, with unchanged exit
  behavior and no job summary;
- `test/m15-committed-artifact.test.ts` — the committed
  `action-dist/index.cjs` is reproduced from source.

## Deliberately absent

M17 writes no GitHub Actions job summary, adds no escaping or list formatter,
changes no CLI, annotation or output byte, and adds no runtime dependency.
