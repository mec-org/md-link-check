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
Extend the existing scanner to recognize explicit anchor targets from <a id="…"> and <a name="…">, raw HTML links from <a href="…">, and raw HTML images from <img src="…">. Attribute names and tag names are case-insensitive; quoted and unquoted attribute values are supported. These forms follow the existing rules for relative targets, anchors, external-URL skipping, code-block exclusion, diagnostics and exit codes. Other raw HTML remains unsupported.
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
