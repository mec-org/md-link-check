# md-link-check

md-link-check is an offline CLI that finds broken relative links, images and heading anchors in a repository's Markdown. It is the software factory's pilot app: small, low-stakes, and checked against real docs. v0.1 is a CLI only, with no runtime dependencies.

See [PROJECT.md](PROJECT.md) for the charter, [ROADMAP.md](ROADMAP.md) for the milestones and [CONTRIBUTING.md](CONTRIBUTING.md) for who may open issues and pull requests.

> **Status: M1.** Relative file, directory and image links plus heading anchors are checked. Reference-style links and `--json` are later milestones; see [Current limitations](#current-limitations).

## Requirements

- Node.js 22.12 or newer
- npm

## Install and build

```bash
npm ci
npm run build
```

`npm run build` compiles `src/` to `dist/`. To put the `md-link-check` command on your PATH, run `npm link` after building.

## Usage

```bash
md-link-check README.md docs/
node dist/cli.js README.md docs/    # without npm link
```

Pass one or more files or directories. A file is checked as given; a directory is searched recursively for `.md` and `.markdown` files. Traversal is deterministic, and `.git` and `node_modules` directories are skipped. Targets are resolved relative to the Markdown file that contains the link.

Each broken target prints one diagnostic:

```text
docs/guide.md:12: ../api/missing.md — target does not exist
docs/guide.md:20: #installation — anchor does not exist
```

Exit codes in M1:

- `0`: every checked target and anchor exists;
- `1`: at least one target or anchor is broken (the usage-error exit code `2` arrives with the interface milestone).

## What M1 checks

- inline links (`[label](target)`) to relative files and directories;
- inline images (`![alt](target)`);
- optional angle-bracket destinations, optional titles, and balanced parentheses in destinations;
- existing files and directories, including directory targets with a trailing slash;
- heading anchors (`[label](#anchor)` and `[label](docs/guide.md#anchor)`) in the same Markdown file or in an existing relative Markdown file;
- ATX headings of one to six `#` with an optional closing `#` sequence, and setext headings underlined by `=` or `-`;
- GitHub-style heading slugs: lowercase, punctuation dropped except hyphens, spaces converted to hyphens, and repeated headings suffixed `-1`, `-2`, and so on.

A target with a fragment is resolved in two steps: the path is checked against the file system, then the fragment is checked against the target document's headings. A missing target file produces only the path diagnostic. Fragments are not checked for targets that are not existing Markdown files, such as directories, images and other file types.

These targets are skipped and never fetched:

- HTTP and HTTPS URLs, and other URI schemes such as `mailto:`;
- root-relative targets such as `/docs/guide.md`.

Fenced code blocks (backtick and tilde fences), indented code blocks and inline code are ignored by the scanner for both links and headings, so examples inside them do not produce diagnostics and do not define anchors.

## Current limitations

- Reference-style links (`[label][ref]`), autolinks and raw HTML links are not scanned. Explicit HTML anchors (`<a id>`, `<a name>`) are not recognised.
- Heading slugs follow the project's stated rule, not every GitHub edge case: Unicode normalisation, HTML entities, percent-decoding, escaped punctuation and emoji handling are not modelled. Characters that are not letters, numbers, combining marks, whitespace or hyphens are dropped, so for example an emoji is removed rather than slugged.
- A repeated heading's generated suffix can collide with a naturally occurring slug (for example a real `Repeat-1` heading); the stated rule does not disambiguate that case.
- Multi-line setext headings use only the line directly above the underline. Text lines inside block quotes and list items are not treated as setext heading text, and headings inside block quotes are not collected.
- Nested inline structures are treated as the outer reference only (for example, a linked image checks the outer link target and not the image).
- Indented code detection is conservative, so a link or heading in a deeply indented block after a blank line can be missed.
- Usage errors do not use exit code `2` yet.
- `--json` is not implemented yet.
- HTTP(S) and other external targets are never fetched or validated.

## Development

```bash
npm test         # builds, then runs the Vitest suite
npm run typecheck
npm run build
```

The package has no runtime dependencies; TypeScript and Vitest are development dependencies only.
