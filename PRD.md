# PRD: md-link-check v0.1

`md-link-check` is a command-line tool that finds broken relative links, images and heading anchors in a repository's Markdown files. It works entirely offline.

## Users

The repository owner and their own documentation repos. It runs locally and in CI. It is not published to npm for general use in v0.1.

## Terms

- **broken link:** a Markdown link or image whose target file, directory or heading does not exist. *Avoid:* dead link, bad link.
- **target:** what a link points to: a file or directory path, optionally with an anchor. *Avoid:* destination, href.
- **anchor:** the `#fragment` of a link, naming a heading in the same or another Markdown file. *Avoid:* hash, bookmark.

## Scope (v0.1)

- **What it checks:**
  - relative links to files and directories;
  - images;
  - anchors to headings in the same Markdown file or another one.
- **External links:** `http(s)` links are counted as skipped and never fetched.
- **Parsing:** a hand-written scanner with no runtime dependencies. It handles:
  - inline links and images;
  - reference-style link definitions;
  - ATX (`#`) and setext (underlined) headings.

  It ignores everything inside fenced code blocks, indented code blocks and inline code.
- **Anchor rule:** GitHub's heading slug:
  - lowercase;
  - punctuation dropped except hyphens;
  - spaces become hyphens;
  - repeated headings get `-1`, `-2`, and so on.

## Interface

- `md-link-check [paths…]` scans the given files and directories for Markdown.
- It prints one line per broken link: `file:line: target — reason`.
- `--json` prints machine-readable results instead.
- **Exit codes:**
  - 0: no broken links;
  - 1: at least one broken link;
  - 2: a usage error.

## Non-goals (v0.1)

- Checking external URLs over the network.
- Explicit HTML anchors (`<a id>`, `<a name>`) and raw HTML links. The README lists them as unsupported.
- A supported library API, a GitHub Action, or an npm release.
- Anchor rules other than GitHub's.

## Definition of done (v0.1)

1. Fixture tests cover every supported form, with no false positives inside code blocks or inline code.
2. Exit codes 0, 1 and 2 and the `--json` output are tested.
3. In a run over the owner's `dsh-copilot` documentation, every reported broken link is confirmed real.
4. CI is green on `main`, and the README documents usage and the unsupported forms.

## Roadmap

- **M0:** scaffold and relative file links.
- **M1:** anchors.
- **M2:** CLI output, exit codes and `--json`.
- **M3:** hardening and the real-docs run.

## Stack

TypeScript, Node 22 and Vitest, with no runtime dependencies.
