# Roadmap — md-link-check

## M0 — Foundation and file links
Scaffold the TypeScript project (Node 22, Vitest, no runtime dependencies) and check relative links to files, directories and images.
Acceptance: tests green; `md-link-check <path>` reports a broken file link with exit 1 and a clean tree with exit 0.

## M1 — Anchors
Collect ATX and setext headings, slug them by GitHub's rule (with -1, -2 for repeats), and check `#anchor` targets in the same file and in other files. Skip fenced, indented and inline code.
Acceptance: fixture tests for every heading and anchor form, with no false positives inside code.

## M2 — Interface
Reference-style links, `file:line: target — reason` output, `--json`, exit code 2 for usage errors, and a count of skipped external links.
Acceptance: exit codes and `--json` tested; usable by someone who did not write it.

## M3 — Hardening and the real-docs run
Edge cases found on real input, and a README with usage and the unsupported forms. Run over the owner's `dsh-copilot` docs, and confirm every reported broken link is real.
Acceptance: the definition of done in PROJECT.md holds; CI green on main. The release decision is the owner's.

## M4 — Explicit HTML anchors and targets
Extend the existing scanner to recognize explicit anchor targets from `<a id="…">` and `<a name="…">`, raw HTML links from `<a href="…">`, and raw HTML images from `<img src="…">`. Attribute names and tag names are case-insensitive; quoted and unquoted attribute values are supported. These forms follow the existing rules for relative targets, anchors, external-URL skipping, code-block exclusion, diagnostics and exit codes. Other raw HTML remains unsupported.
Acceptance: fixture tests cover supported anchor, link and image forms, attribute ordering and casing, quoted and unquoted values, same-file and cross-file anchors, missing targets, and exclusion inside fenced, indented and inline code; existing Markdown fixtures remain green; the PR changes neither `.github/` nor `.project/`.

## M5 — Opt-in external checking contract
Add `--external` as an opt-in interface: without it, external URLs remain counted as skipped and no network request is made; with it, each distinct HTTP or HTTPS target is checked using Node's built-in `fetch`. A successful final HTTP response is not a broken link; a terminal HTTP error, timeout or network failure is reported as a broken link after the configured retry policy is exhausted. Exit code 0 means no broken links, exit code 1 means at least one local or external broken link, and exit code 2 remains a usage error. Extend `--json` additively with external-check summary counts and identify external results without removing or renaming existing fields.
Acceptance: CLI tests prove that the default path performs no fetch, `--external` changes exit status only through reported broken links, usage errors still exit 2, human-readable diagnostics retain `file:line: target — reason`, and existing JSON consumers can ignore the new fields; all network tests use a local HTTP server fixture; the external contract and JSON additions are documented; the PR changes neither `.github/` nor `.project/`.

## M6 — Bounded external transport
Harden `--external` with documented finite defaults for request timeout, global concurrency, per-host concurrency or delay, retryable statuses and network failures, maximum retry attempts, redirect handling, and a persistent result cache with a documented location, key, freshness period and invalidation behavior. Deduplicate repeated targets before scheduling requests, never retry permanent HTTP failures, and ensure every request, retry and cache entry is bounded.
Acceptance: deterministic local-server tests cover success, redirect, permanent failure, retry followed by success, retry exhaustion, timeout, concurrency enforcement, per-host politeness, target deduplication, cache hit, stale-cache refresh and malformed-cache recovery; tests prove that retries and waits have ceilings and that no real network endpoint is contacted; the PR changes neither `.github/` nor `.project/`.

## M7 — Tagged-ref GitHub Action
Add root-level action metadata and a checked-in, reproducibly built action entrypoint that wraps the CLI without publishing to npm. The action accepts paths and opt-in external checking, preserves the CLI's diagnostics and exit semantics, and is consumable as `mec-org/md-link-check@<tag>`; it must resolve its executable relative to the action's own directory so that it works when invoked from a tagged ref against another repository.
Acceptance: a test or repository-local script validates the root action metadata, rebuilds the checked-in entrypoint and fails on a diff, runs the wrapper against clean and broken fixtures, verifies propagation of exit codes 0, 1 and 2 and `--external`, and simulates invocation from a directory other than the action repository; no workflow is added, no npm publication is required, and the PR changes neither `.github/` nor `.project/`.

## M8 — v0.2 hardening and real-docs run
Exercise the complete v0.2 CLI against the owner's `dsh-copilot` documentation, including supported raw HTML forms, while keeping the acceptance run offline unless the owner separately authorizes external network access. Resolve edge cases, update the README with the v0.2 interface, additive output and JSON changes, cache behavior, unsupported forms, action usage by tagged ref, and the unchanged npm non-goal.
Acceptance: the v0.2 definition of done in PROJECT.md holds; every reported local broken link from the real-docs run is confirmed real; an offline acceptance run requires no network and creates no untracked file in the checked repository; the action validation script passes; CI is green on `main`; neither `.github/` nor `.project/` is changed; the release and tag decision goes to the owner.

## M9 — CI result contract
Give the action wrapper, in-process, the structured broken-link results it needs for annotations (file, source line, target and reason, in the CLI's result order) without parsing text output and without changing the CLI's human-readable or JSON surfaces. Add regression fixtures that freeze the current CLI output, JSON fields and exit codes before any action rendering is added.
Acceptance: tests prove the wrapper receives each broken link's file, line, target and reason in result order; the covered human-readable lines are byte-for-byte unchanged; no JSON field is removed or renamed; exit codes 0, 1 and 2 keep their meanings; `action-dist/index.cjs` is current.

## M10 — Workflow-command annotation formatter
Add a bounded formatter that turns each broken-link result into one GitHub workflow-command annotation with its Markdown file, line and diagnostic message, kept separate from link discovery so local CLI behavior is unchanged. It is not yet wired into the action.
Acceptance: unit tests prove one annotation per representative broken link with its file, line and message, result order preserved for several findings, and no annotation for zero findings.

## M11 — Safe annotation values
Escape the values that workflow commands treat specially in annotation messages and properties, so file names, targets and reasons containing such characters keep their meaning and each finding stays one annotation. Target resolution, reasons and ordinary CLI output do not change.
Acceptance: tests cover file names, targets and reasons with characters workflow commands treat specially; each yields exactly one annotation with its values intact; the matching human-readable diagnostic is unchanged.

## M12 — Action annotation integration
Emit the annotations from the existing action entrypoint, keeping its `paths` and `external` inputs and printing the CLI's own output unchanged. Regenerate `action-dist/index.cjs` with the existing build script; direct CLI runs stay free of workflow commands.
Acceptance: action-level tests prove a broken local target prints its unchanged diagnostic plus one file-and-line annotation, a clean run prints neither, direct CLI tests emit no workflow command, and `npm test` confirms `action-dist/index.cjs` is current.

## M13 — Summary-count outputs
Declare action outputs in `action.yml` for the run's `summary.filesChecked`, `summary.broken` and `summary.externalSkipped`, and publish their values after the run without changing the `paths` or `external` inputs or the printed output.
Acceptance: tests prove `action.yml` declares the three outputs, published values equal the run's summary counts for clean and broken fixtures, the printed CLI output is unchanged, and `action-dist/index.cjs` is current.

## M14 — Exit and usage interaction
Keep the established outcomes while annotations and outputs are active: a clean run exits 0, at least one broken link exits 1, a usage error exits 2. Annotations and outputs never replace, suppress or reinterpret the CLI's result.
Acceptance: action-level tests cover exits 0, 1 and 2; broken-link runs keep their annotations and outputs; usage errors never become broken-link annotations; usage and diagnostic text are unchanged; `action-dist/index.cjs` is current.

## M15 — Offline and external-mode interaction
Check the CI-facing layer in both action modes, the default offline mode and `external: true`, with every external test using only a local HTTP server fixture. Annotations and outputs follow the CLI's existing result classifications, with no new transport policy.
Acceptance: tests prove default action runs fetch no HTTP(S) target, external-mode tests use only a local server, terminal external failures exit 1 and produce their annotations and counts, skipped external targets follow the existing default, and `action-dist/index.cjs` is current.

## M16 — v0.3 hardening, documentation and real-docs run
Add interaction and regression coverage across several files, several findings, images, anchors and external results. Update `README.md` and `docs/` for the annotations, the outputs and the unchanged CLI output, and bring the README's release-tag statements, and the README contract tests that check them, in line with the tags that exist. Run the CLI and the action wrapper offline over the owner's `dsh-copilot` documentation from the root-owned, read-only snapshot `/opt/dsh-factory/snapshots/dsh-copilot@fc98b7b953f59f4e747d14164119770f1777e96d/`, without real-internet checks.
Acceptance: the v0.3 definition of done in PROJECT.md holds; all tests and builds pass and `action-dist/index.cjs` is current; the offline real-docs run completes, every reported local broken link is confirmed real, and it leaves no untracked file; the milestone changes only `src/`, `test/`, `docs/`, `README.md`, `action.yml` and `action-dist/index.cjs`; CI is green on `main`; the release and tag decision goes to the owner.
