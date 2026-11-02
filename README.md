# md-link-check

md-link-check is an offline CLI that finds broken relative links, images and heading anchors in a repository's Markdown. It is the software factory's pilot app: small, low-stakes, and checked against real docs. v0.1 is a CLI only, with no runtime dependencies.

See [PROJECT.md](PROJECT.md) for the charter, [ROADMAP.md](ROADMAP.md) for the milestones and [CONTRIBUTING.md](CONTRIBUTING.md) for who may open issues and pull requests.

> **Status: M0.** Only relative file, directory and image links are checked. Heading anchors, reference-style links and `--json` are later milestones; see [Current limitations](#current-limitations).

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
```

Exit codes in M0:

- `0`: every checked target exists;
- `1`: at least one target is broken (the usage-error exit code `2` arrives with the interface milestone).

## What M0 checks

- inline links (`[label](target)`) to relative files and directories;
- inline images (`![alt](target)`);
- optional angle-bracket destinations, optional titles, and balanced parentheses in destinations;
- existing files and directories, including directory targets with a trailing slash;
- for a target with a fragment, only its path (`docs/guide.md#install` checks `docs/guide.md`).

These targets are skipped and never fetched:

- HTTP and HTTPS URLs, and other URI schemes such as `mailto:`;
- fragment-only targets such as `#installation`;
- root-relative targets such as `/docs/guide.md`.

Fenced code blocks, indented code blocks and inline code are ignored by the scanner, so examples inside them do not produce diagnostics.

## Current limitations

- Heading anchors are not checked yet; fragment-only targets never fail in M0.
- Reference-style links (`[label][ref]`), autolinks and raw HTML links are not scanned.
- Nested inline structures are treated as the outer reference only (for example, a linked image checks the outer link target and not the image).
- Indented code detection is conservative, so a link in a deeply indented block after a blank line can be missed.
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
