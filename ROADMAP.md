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
