# M19 — Diagnostic list formatter

Base: `c20c394aa85a6d07d7bc3f2e65567ade8945a050` (M18, #48).

M19 adds one pure formatter that turns the M17 run-summary counts and the
ordered broken-link findings into the Markdown fragment the future GitHub
Actions job summary will show. The formatter is not wired into the action, the
CLI or `src/action-runner.ts`; it writes no file and reads no environment.
`action-dist/index.cjs` is unchanged.

## Module and exports

`src/summary-markdown.ts` now exports, beside the M18 escaper:

- `formatRunSummaryMarkdown(counts: ActionSummary, diagnostics:
  readonly BrokenLinkResult[]): string` — formats one run summary;
- `SUMMARY_DIAGNOSTIC_LIMIT` — the documented diagnostic limit, `50`.

The two input types are the existing M17 contract types from `src/run.ts`
(`ActionSummary`, `BrokenLinkResult`), imported with `import type`; M19 does not
create a second result model or copy the count or finding shapes. The type-only
import is erased at compile time, so the module has no runtime import, reads no
environment, performs no I/O and adds no runtime dependency, as M18 required.

## Exact Markdown grammar

The formatter returns a Markdown fragment that always ends with exactly one
newline. `<n>` is a decimal number; `...` marks zero or more repetitions.

```text
## Results

- Checked: <filesChecked>
- Broken: <broken>
- External skipped: <externalSkipped>

## Diagnostics            (only when at least one finding is supplied)

- <file>:<line>: <target> — <reason>
...

<total> total diagnostics; <notListed> not listed.   (only when total > 50)
```

- The counts section comes first, with one labeled line per M17 count. The
  supplied counts are rendered unchanged; the formatter never recomputes them.
- With at least one finding, a blank line separates the counts from the
  `## Diagnostics` heading, which is followed by a blank line and one bullet
  per listed finding.
- With zero findings the diagnostics section is omitted, so a clean run ends
  after the three count lines and no empty list is emitted.
- When the total exceeds the limit, one blank line separates the bullets from
  the final plain disclosure line.
- `- Checked:`, `- Broken:`, `- External skipped:`, `## Results`,
  `## Diagnostics`, the `: ` and ` — ` separators and the disclosure sentence
  are fixed grammar. The em dash matches the CLI's existing
  `file:line: target — reason` diagnostic notation.

The Markdown context is one inline summary entry per finding (a list item), the
context for which the M18 escaper is documented. No raw inline-code delimiters
wrap an untrusted value.

## Selection, ordering and disclosure

For `total = diagnostics.length`:

- listed diagnostics are the order-preserving prefix
  `diagnostics.slice(0, SUMMARY_DIAGNOSTIC_LIMIT)`, i.e. indices 0 through 49;
- the stated total is `total`;
- the not-listed count is `max(total - SUMMARY_DIAGNOSTIC_LIMIT, 0)`.

The formatter does not sort, mutate, deduplicate, regroup or reconstruct the
findings, and it never truncates an individual value. Its only bound is the
number of listed findings. Line numbers and the count values are rendered with
their ordinary decimal representation, so the output is deterministic and
locale-independent.

The M17 contract has both an authoritative `summary.broken` count and the
ordered findings; `broken` is defined as the number of diagnostics and both are
projected from the same completed run. The formatter renders the supplied
`broken` count as supplied and derives the disclosure total from
`diagnostics.length`, which is the M17 relationship. A test formats the M17
oracle counts and findings together and asserts they agree, so the two cannot
silently contradict each other in the production seam.

## Escaping

Every listed finding's file, target and reason is passed through the M18
`escapeSummaryValue` function before it is placed in the entry. M19 does not
duplicate, partially reimplement or bypass that escaping. Because the escaper
removes raw line breaks and control characters and neutralises Markdown
structure, each finding remains exactly one entry even when its values contain
backticks, pipes, asterisks, underscores, brackets, angle brackets, a leading
`#`, line breaks or controls.

## Tests

`test/summary-diagnostic-list.test.ts` independently freezes the Markdown:

1. `formats counts and zero diagnostics` — exact counts-only output, no bullets
   and no disclosure;
2. `formats one diagnostic` — file, line, target and reason, exactly one entry,
   exact output;
3. `lists exactly fifty diagnostics` — all 50 in supplied order, the constant
   is 50, no disclosure;
4. `limits fifty-one diagnostics and reports one not listed` — indices 0–49
   listed, index 50 absent, `51 total diagnostics; 1 not listed.`;
5. `reports the correct omitted count above fifty-one` — 73 findings, 50 listed,
   23 not listed, total stays 73;
6. `preserves supplied result order` — supplied order differs from lexical,
   file and line order, and frozen inputs prove no mutation;
7. `escapes every diagnostic value through the M18 escaper` — hostile values in
   all three fields, literal expected encodings, comparison with the public M18
   escaper, and proof that no value adds a line or Markdown structure;
8. `uses exact deterministic Markdown grammar` — literal expected output,
   labels, punctuation, blank lines and exactly one final newline, called twice;
9. `keeps the M17 broken count equal to the formatted diagnostics total` — the
   M17 oracle's `broken` and finding count agree and are rendered consistently;
10. `does not truncate an individual diagnostic value` — a long reason is
    rendered in full.

M18 escaping is unchanged: `test/summary-markdown.test.ts` still passes.

## Deliberately absent

M19 adds no summary-file writing, `GITHUB_STEP_SUMMARY` handling, environment
detection, byte budgeting, annotation formatting or action integration. It
changes no CLI text or JSON, annotation, action output, action input or exit
behavior, and no v0.4 milestone changes `package.json`, a lockfile, `scripts/`,
`.github/`, `.project/`, `PROJECT.md` or `ROADMAP.md`.
