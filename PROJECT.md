# md-link-check

md-link-check is an offline CLI that finds broken relative links, images and heading anchors in a repository's Markdown. It is the software factory's pilot app: small, low-stakes, and checked against real docs. v0.1 is a CLI only, with no runtime dependencies.

Source PRD: [PRD.md](PRD.md)

## Users

The repository owner and their own documentation repos. It runs locally and in CI. The first real input is the owner's `dsh-copilot` docs. It is not published to npm in v0.1.

## Scope (v0.1.0)

- **What it checks:**
  - relative links to files and directories;
  - images;
  - anchors to headings in the same Markdown file or another one.
- **External links:** `http(s)` links are counted as skipped and never fetched.
- **Parsing:** a hand-written scanner with no runtime dependencies. It handles:
  - inline links and images;
  - reference-style link definitions;
  - ATX and setext headings.

  It ignores fenced code blocks, indented code blocks and inline code.
- **Anchor rule:** GitHub's heading slug:
  - lowercase;
  - punctuation dropped except hyphens;
  - spaces become hyphens;
  - repeated headings get `-1`, `-2`.
- **Interface:** `md-link-check [paths…]`.
  - It prints `file:line: target — reason` for each broken link.
  - `--json` prints machine-readable results instead.
  - Exit codes: 0 for no broken links, 1 for at least one, 2 for a usage error.

## Non-goals

- Checking external URLs over the network.
- Explicit HTML anchors (`<a id>`, `<a name>`) and raw HTML links. The README lists them as unsupported.
- A supported library API, a GitHub Action, or an npm release.
- Anchor rules other than GitHub's.

## Canonical terminology

- **broken link** → a Markdown link or image whose target file, directory or heading does not exist. Not "dead link" or "bad link".
- **target** → what a link points to: a file or directory path, optionally with an anchor. Not "destination" or "href".
- **anchor** → the `#fragment` of a link, naming a heading. Not "hash" or "bookmark".
- **outside contributor** → any GitHub user who is not a collaborator on this repo.

## Irreversible decisions

- **This repo is public.** Its history can be cloned and cached, so never commit secrets, credentials, tenant data or personal data.
- **No runtime dependencies.** A parser dependency would need the factory's dependency check and the owner's approval.
- **The CLI is the only supported surface.** Output format and exit codes are the contract.

## Open questions

- None blocking. External URL checking is the first candidate after v0.1.

## Definition of done (v0.1)

1. Fixture tests cover every supported form, with no false positives inside code blocks or inline code.
2. Exit codes 0, 1 and 2 and the `--json` output are tested.
3. In a run over the owner's `dsh-copilot` docs, every reported broken link is confirmed real.
4. CI is green on `main`, and the README documents usage and the unsupported forms.

When all four hold, the mission stops and the release decision goes to the owner.
