# md-link-check

md-link-check is an offline CLI that finds broken relative links, images and heading anchors in a repository's Markdown. It is the software factory's pilot app: small, low-stakes, and checked against real docs. v0.1 is a CLI only, with no runtime dependencies.

See [PROJECT.md](PROJECT.md) for the charter, [ROADMAP.md](ROADMAP.md) for the milestones and [CONTRIBUTING.md](CONTRIBUTING.md) for who may open issues and pull requests.

> **Status: M2.** Inline and reference-style links and images, heading anchors, stable text output, `--json` and the documented exit codes are implemented. The M3 hardening pass and the real-docs run are still ahead; see [Current limitations](#current-limitations).

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
md-link-check [--json] [--] <path...>
md-link-check --help
node dist/cli.js README.md docs/    # without npm link
```

Pass one or more files or directories. A file is checked as given; a directory is searched recursively for `.md` and `.markdown` files. Traversal is deterministic, and `.git` and `node_modules` directories are skipped. Targets are resolved relative to the Markdown file that contains the link.

Options:

- `--json` writes one JSON document to standard output instead of text output;
- `--help` (or `-h`) prints usage and the exit codes and exits `0`;
- `--` ends option parsing, so a path beginning with `-` can be checked.

Text mode writes diagnostics and a final summary to standard output. Usage errors are written to standard error. With `--json`, standard output contains only the JSON document. The process exit code is the same in both modes.

## Text output

Each broken target prints one diagnostic to standard output:

```text
docs/guide.md:12: ../api/missing.md — target does not exist
docs/guide.md:20: #installation — anchor does not exist
```

The line is exactly `file:line: target — reason`:

- `file` is the Markdown source containing the link or image use;
- `line` is one-based;
- `target` is the destination as written (for an undefined reference use, the reference label);
- `reason` is one of `target does not exist`, `anchor does not exist` or `reference definition does not exist`.

Reference-style diagnostics point to the use, not the definition. Diagnostics are deterministic: files are checked in discovery order and uses in document order.

A summary line follows the diagnostics, including when nothing is broken and when no external link was skipped:

```text
Checked 2 files: 1 broken target, 3 external links skipped.
```

## JSON output

`--json` writes exactly one version 1 JSON document to standard output and nothing else. A clean run:

```json
{
  "version": 1,
  "ok": true,
  "exitCode": 0,
  "summary": {
    "filesChecked": 2,
    "broken": 0,
    "externalSkipped": 3
  },
  "diagnostics": []
}
```

A broken run fills `diagnostics` in deterministic order:

```json
{
  "version": 1,
  "ok": false,
  "exitCode": 1,
  "summary": {
    "filesChecked": 2,
    "broken": 1,
    "externalSkipped": 3
  },
  "diagnostics": [
    {
      "file": "docs/guide.md",
      "line": 12,
      "target": "../api/missing.md",
      "reason": "target does not exist"
    }
  ]
}
```

The properties are:

- `version`: schema version, currently `1`;
- `ok`: `true` only when `exitCode` is `0`;
- `exitCode`: the process exit code;
- `summary.filesChecked`: number of unique files checked;
- `summary.broken`: number of diagnostics (broken targets and undefined reference uses);
- `summary.externalSkipped`: number of skipped HTTP(S) link and image uses;
- `diagnostics`: ordered array of `{ file, line, target, reason }` objects.

A usage error keeps the same top-level shape: `ok` is `false`, `exitCode` is `2`, the summary counts are zero, and `diagnostics` contains one entry with an empty `file` and `target`, `line` `0`, and the error message as `reason`. For example:

```json
{
  "version": 1,
  "ok": false,
  "exitCode": 2,
  "summary": {
    "filesChecked": 0,
    "broken": 0,
    "externalSkipped": 0
  },
  "diagnostics": [
    {
      "file": "",
      "line": 0,
      "target": "",
      "reason": "no input paths"
    }
  ]
}
```

## Exit codes

- `0`: checking completed and no broken targets were found;
- `1`: checking completed and at least one broken target was found;
- `2`: usage error: no input paths, an unknown option, or an input path that cannot be read.

A file or directory input that cannot be accessed is treated as an invalid command-line argument (exit `2`), not as a broken Markdown target. A broken target inside a readable Markdown file is always exit `1`. No other exit codes are used.

## What M2 checks

- inline links (`[label](target)`) to relative files and directories;
- inline images (`![alt](target)`);
- full reference-style links and images (`[text][label]`, `![alt][label]`), collapsed forms (`[text][]`, `![alt][]`) and shortcut forms (`[text]`, `![alt]`) when a matching definition exists;
- optional angle-bracket destinations, optional titles, and balanced parentheses in inline destinations;
- existing files and directories, including directory targets with a trailing slash;
- heading anchors (`[label](#anchor)` and `[label](docs/guide.md#anchor)`) in the same Markdown file or in an existing relative Markdown file, including anchors on reference-style destinations;
- ATX headings of one to six `#` with an optional closing `#` sequence, and setext headings underlined by `=` or `-`;
- GitHub-style heading slugs: lowercase, punctuation dropped except hyphens and underscores, spaces converted to hyphens, inline and reference-style link labels used instead of their destinations, matched emphasis markers removed, and every generated slug reserved so repetitions and collisions get the next free `-1`, `-2`, … suffix.

A target with a fragment is resolved in two steps: the path is checked against the file system, then the fragment is checked against the target document's headings. A percent-encoded fragment is decoded before that comparison; a fragment that is not valid percent-encoding is compared as written. A missing target file produces only the path diagnostic. Fragments are not checked for targets that are not existing Markdown files, such as directories, images and other file types.

Reference definitions use `[label]: target`, optionally indented by up to three spaces, with `<...>` destinations and `"..."`, `'...'` or `(...)` titles:

```markdown
[guide][docs]
![diagram][architecture]

[docs]: docs/guide.md
[architecture]: images/architecture.png
```

Reference labels match case-insensitively and surrounding whitespace is trimmed; internal whitespace is not collapsed. A definition applies to uses in the same Markdown file. When a label is defined more than once, the first definition wins and later definitions are ignored. A definition that is never used produces no finding and does not affect the external count. An undefined full or collapsed reference use is reported at the use line with reason `reference definition does not exist`; an undefined shortcut (`[text]`) is left as ordinary bracketed text so prose does not produce findings.

These targets are skipped and never fetched:

- HTTP and HTTPS URLs, and other URI schemes such as `mailto:`;
- root-relative targets such as `/docs/guide.md`.

Fenced code blocks (backtick and tilde fences), indented code blocks and inline code are ignored by the scanner for links, images, reference definitions and headings, so examples inside them do not produce diagnostics, do not define references and do not define anchors.

## External link count

`summary.externalSkipped` and the text summary count every encountered `http:` or `https:` link and image use that is skipped, including inline uses and resolved reference-style uses. The count is per use, not per unique destination, so the same URL used three times counts three. An unused external reference definition is not counted.

Other URI schemes (`mailto:`, `ftp:`), protocol-relative targets (`//example.com`) and root-relative targets are skipped but are not included in the HTTP(S) count. No destination is ever fetched, and the tool never opens a network connection.

## Current limitations

- Autolinks (`<https://example.com>`) and raw HTML links are not scanned. Explicit HTML anchors (`<a id>`, `<a name>`) are not recognised.
- Heading slugs follow the project's GitHub-style rule, not every github-slugger edge case: Unicode normalisation, HTML entities and escaped punctuation are not modelled. The slug is taken from the heading's rendered text, so inline and reference-style link destinations are replaced by their labels, inline code keeps its literal content, matched emphasis markers are removed and intraword underscores are kept; characters that are not letters, numbers, combining marks, whitespace, hyphens or underscores are dropped (for example, an emoji is removed).
- Multi-line setext headings use only the line directly above the underline. Text lines inside block quotes and list items are not treated as setext heading text, and headings inside block quotes are not collected.
- Nested inline structures are treated as the outer reference only (for example, a linked image checks the outer link target and not the image).
- Indented code detection is conservative, so a link or heading in a deeply indented block after a blank line can be missed.
- Reference definitions and labels must fit on one line. Multi-line definitions and labels, internal whitespace collapsing, and CommonMark's full block-boundary rules are not modelled: a definition line is recognised when it starts a line with up to three spaces. Labels are compared literally after trimming and lowercasing, so backslash escapes inside labels are not normalised.
- HTTP(S) and other external targets are never fetched or validated.

## Development

```bash
npm test         # builds, then runs the Vitest suite
npm run typecheck
npm run build
```

The package has no runtime dependencies; TypeScript and Vitest are development dependencies only.
