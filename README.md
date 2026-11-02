# md-link-check

md-link-check is an offline CLI that finds broken relative links, images and heading anchors in a repository's Markdown. It is the software factory's pilot app: small, low-stakes, and checked against real docs. v0.1 is a CLI only, with no runtime dependencies.

See [PROJECT.md](PROJECT.md) for the charter, [ROADMAP.md](ROADMAP.md) for the milestones and [CONTRIBUTING.md](CONTRIBUTING.md) for who may open issues and pull requests.

> **Status: v0.1's checks and the M4 raw HTML forms are implemented.** Inline and reference-style links and images, heading anchors, explicit `<a id>`/`<a name>` anchors, raw HTML `<a href>` links and `<img src>` images, stable text output, `--json` and the documented exit codes are implemented. The later v0.2 milestones (opt-in external checking and the GitHub Action) are not implemented yet. The release decision is the owner's. See [Current limitations](#current-limitations).

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

Pass one or more files or directories. An explicit file is checked as given, even if its name does not end in `.md`; a directory is searched recursively for `.md` and `.markdown` files (the extension is matched case-insensitively). Traversal is deterministic; `.git` and `node_modules` directories are skipped, and symlinked entries found during a walk are not followed. Targets are resolved relative to the Markdown file that contains the link.

Options:

- `--json` writes one JSON document to standard output instead of text output;
- `--help` (or `-h`) prints usage and the exit codes and exits `0`;
- `--` ends option parsing, so a path beginning with `-` can be checked.

Text mode writes diagnostics and a final summary to standard output. Usage errors are written to standard error. With `--json`, a check run writes only the JSON document to standard output. `--help` always prints the help text to standard output and exits `0`, even when `--json` is also given. The process exit code is the same in both modes.

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
      "column": 5,
      "kind": "link",
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
- `error`: present only for a usage error; contains `kind` (`"usage"`) and `message`, and `diagnostics` is empty in that case;
- `summary.filesChecked`: number of unique files checked;
- `summary.broken`: number of diagnostics (broken targets and undefined reference uses);
- `summary.externalSkipped`: number of skipped HTTP(S) link and image uses;
- `diagnostics`: ordered array of `{ file, line, column, kind, target, reason }` objects. `column` is one-based and points at the `[` or `!` of a Markdown reference, or at the `<` of a supported raw HTML tag; `kind` is `"link"` or `"image"`.

A usage error keeps the same top-level shape: `ok` is `false`, `exitCode` is `2`, the summary counts are zero, `diagnostics` is empty, and the top-level `error` field describes the failure (`kind` is `"usage"`, `message` is the error). A usage error is never reported as a link diagnostic. For example:

```json
{
  "version": 1,
  "ok": false,
  "exitCode": 2,
  "error": {
    "kind": "usage",
    "message": "no input paths"
  },
  "summary": {
    "filesChecked": 0,
    "broken": 0,
    "externalSkipped": 0
  },
  "diagnostics": []
}
```

## Exit codes

- `0`: checking completed and no broken targets were found;
- `1`: checking completed and at least one broken target was found;
- `2`: usage error: no input paths, an unknown option, or an input path that cannot be read.

A top-level input path that cannot be accessed is treated as an invalid command-line argument (exit `2`), not as a broken Markdown target. A broken target inside a readable Markdown file is always exit `1`. No other exit codes are used.

## What is checked

- inline links (`[label](target)`) to relative files and directories;
- inline images (`![alt](target)`);
- full reference-style links and images (`[text][label]`, `![alt][label]`), collapsed forms (`[text][]`, `![alt][]`) and shortcut forms (`[text]`, `![alt]`) when a matching definition exists;
- optional angle-bracket destinations, optional titles, and balanced parentheses in inline destinations;
- existing files and directories, including directory targets with a trailing slash;
- heading anchors (`[label](#anchor)` and `[label](docs/guide.md#anchor)`) in the same Markdown file or in an existing relative Markdown file, including anchors on reference-style destinations;
- ATX headings of one to six `#` with an optional closing `#` sequence, and setext headings underlined by `=` or `-`;
- GitHub-style heading slugs: lowercase, punctuation dropped except hyphens and underscores, spaces converted to hyphens, inline and reference-style link labels used instead of their destinations, matched emphasis markers removed, and every generated slug reserved so repetitions and collisions get the next free `-1`, `-2`, … suffix;
- explicit HTML anchor targets and raw HTML links and images in the four supported forms described in [Raw HTML anchors and targets](#raw-html-anchors-and-targets).

A target with a fragment is resolved in two steps: the path is checked against the file system, then the fragment is checked against the target document's heading anchors and explicit HTML anchors. A percent-encoded fragment is decoded before that comparison; a fragment that is not valid percent-encoding is compared as written. A missing target file produces only the path diagnostic. Fragments are not checked for targets that are not existing Markdown files, such as directories, images and other file types.

Reference definitions use `[label]: target`, optionally indented by up to three spaces, with `<...>` destinations and `"..."`, `'...'` or `(...)` titles:

```markdown
[guide][docs]
![diagram][architecture]

[docs]: docs/guide.md
[architecture]: images/architecture.png
```

Reference labels match case-insensitively; surrounding whitespace is trimmed and every internal run of spaces or tabs collapses to one space. A definition applies to uses in the same Markdown file. When a label is defined more than once, the first definition wins and later definitions are ignored. A definition that is never used produces no finding and does not affect the external count. An undefined full or collapsed reference use is reported at the use line with reason `reference definition does not exist`; an undefined shortcut (`[text]`) is left as ordinary bracketed text so prose does not produce findings.

## Raw HTML anchors and targets

The scanner recognises four raw HTML forms in addition to Markdown links and headings:

- explicit anchor targets declared by `<a id="…">` and `<a name="…">`;
- raw HTML links declared by `<a href="…">`;
- raw HTML images declared by `<img src="…">`.

Tag and attribute names are matched case-insensitively. The relevant attribute may appear in any order among unrelated attributes, and its value may be double-quoted, single-quoted or unquoted:

```html
<A ID="section">
<a NaMe="section">
<a id='other'></a>
<a name=third></a>
<A HREF="guide.md">
<IMG SRC="image.png">
<a href='guide.md'>Single-quoted</a>
<a href=guide.md>Unquoted</a>
<img alt="Diagram" src="diagram.png" width="400">
```

An `<a href>` or `<img src>` value is checked exactly like a Markdown link or image target:

- a relative path is resolved from the containing Markdown file, including directory targets;
- `http:` and `https:` targets are skipped, counted once per use and never fetched;
- a fragment resolves against the heading anchors and explicit anchors of the same Markdown file or an existing relative Markdown file;
- a missing file or anchor produces the existing `target does not exist` or `anchor does not exist` diagnostic and exit `1`;
- the target is preserved as written, and the diagnostic line is the line containing the opening tag.

These uses flow through the existing text and JSON reporters and exit codes: a document with only valid explicit anchors and raw HTML targets exits `0`, a broken raw HTML target or explicit anchor exits `1`, and usage errors remain exit `2`. Text diagnostics keep the `file:line: target — reason` form and the JSON schema is unchanged.

Explicit anchors are literal and document-local: they augment heading-generated anchors, are not slugified, and never receive `-1`/`-2` suffixes. Repeated identical values resolve to the same anchor. An empty value such as `<a id="">` is not a usable anchor and produces no diagnostic by itself; an empty `href` or `src` value is ignored like an empty Markdown destination. When one `<a>` tag has both `id` and `name`, both non-empty values are collected.

The scanner reads the first syntactically valid occurrence of a duplicated relevant attribute (`href`, `src`, `id`, `name`) on one tag. Values are kept literally: HTML entities are not decoded, explicit anchor values are not percent-decoded or Unicode-normalised, and malformed HTML is not recovered. A supported tag must be closed on the same line; an unclosed tag is ignored. These are deterministic scanner rules, not a standards-complete HTML or CommonMark parser.

Only those attributes on `<a>` and `<img>` are recognised. Other raw HTML remains unsupported and produces no HTML anchor, link or image finding:

```html
<div id="section">
<h2 id="section">
<span id="section">
<video src="movie.mp4" poster="movie.mp4"></video>
<img srcset="small.png 1x, large.png 2x">
<script src="app.js"></script>
<a style="background: url('style.css')">
<a data-href="guide.md">
```

HTML comments are not a distinct construct: supported-looking tags and ordinary Markdown link syntax inside them are scanned like the surrounding text. Ordinary Markdown link syntax inside other raw HTML is also still scanned as Markdown, as before. Supported raw HTML tags inside code are not scanned; see the code-exclusion rule below.

These targets are skipped and never fetched:

- HTTP and HTTPS URLs, and other URI schemes such as `mailto:`;
- root-relative targets such as `/docs/guide.md`.

Fenced code blocks (backtick and tilde fences) and indented code blocks at the top level, and single-line inline code, are ignored by the scanner for links, images, reference definitions, headings and supported raw HTML tags, so examples inside them do not produce diagnostics, do not define references or anchors and are not counted as external uses.

## External link count

`summary.externalSkipped` and the text summary count every encountered `http:` or `https:` link and image use that is skipped, including inline uses, resolved reference-style uses and supported raw HTML uses. The count is per use, not per unique destination, so the same URL used three times counts three. An unused external reference definition is not counted.

Other URI schemes (`mailto:`, `ftp:`), protocol-relative targets (`//example.com`) and root-relative targets are skipped but are not included in the HTTP(S) count. No destination is ever fetched, and the tool never opens a network connection.

## CI

The CLI can run as a normal CI step after a build. The example below runs inside a checkout of md-link-check itself and checks that checkout's `docs/` tree. There is no published package or GitHub Action, so invoke the built file directly:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm ci --ignore-scripts
- run: npm run build
- run: node dist/cli.js docs
```

To check a different repository, check out md-link-check at a pinned commit into a subdirectory, build it there, and run `node md-link-check/dist/cli.js <path-to-that-repository>` from the job workspace.

The step fails the job with exit `1` when a broken target is found and exit `2` on a usage error. Add `--json` and redirect standard output when a machine-readable report is needed as an artifact; the report is written before the process exits.

## Current limitations

- Autolinks (`<https://example.com>`) are not scanned. Raw HTML support is limited to explicit anchors from `<a id>`/`<a name>`, links from `<a href>` and images from `<img src>`; it is not an HTML parser or a DOM. Supported tags must be closed on the same line, entities are not decoded, explicit anchor values are not percent-decoded or Unicode-normalised, malformed HTML is not recovered, and only the first valid duplicated relevant attribute on a tag is read. HTML comments are not a distinct construct: supported-looking tags and ordinary Markdown link syntax inside them are scanned as text. Link-like syntax inside other raw HTML is also still scanned as ordinary Markdown. Block-quote markers are not stripped, so a fenced code block or heading written inside a block quote is not recognised as such; link-like text there can still be scanned as prose.
- Heading slugs follow the project's GitHub-style rule, not every github-slugger edge case: Unicode normalisation, HTML entities and escaped punctuation are not modelled. The slug is taken from the heading's rendered text, so inline and reference-style link destinations are replaced by their labels, inline code keeps its literal content, matched emphasis markers are removed and intraword underscores are kept; characters that are not letters, numbers, combining marks, whitespace, hyphens or underscores are dropped (for example, an emoji is removed).
- Multi-line setext headings use only the line directly above the underline. Text lines inside block quotes and list items are not treated as setext heading text, and headings inside block quotes are not collected.
- Link labels and destinations, inline code spans, reference definitions and supported raw HTML tags must fit on one line. A link, code span or tag that wraps across lines is not scanned as one span.
- Placeholder or template links written as ordinary Markdown are checked as real targets; put illustrative link syntax in a code span or fenced code block so it is ignored.
- Nested inline structures are treated as the outer reference only (for example, a linked image checks the outer link target and not the image).
- Indented code detection is conservative, so a link, raw HTML target or heading in a deeply indented block after a blank line can be missed.
- Reference definitions follow a simplified single-line form: a definition line is recognised when it starts a line with up to three spaces. CommonMark's full block-boundary rules are not modelled. Labels are normalised only by trimming, collapsing internal spaces or tabs, and lowercasing, so backslash escapes inside labels are not normalised.
- Unsupported or unspecified: percent-encoded path characters, query strings, and scheme-like or colon-containing targets (including Windows drive paths). Do not rely on a particular interpretation of these forms in v0.1. Percent-encoded fragments are decoded; see above.
- Windows-style backslashes are not converted to separators. On POSIX systems `docs\guide.md` is a literal filename, so a Windows-style target normally does not resolve there. Case sensitivity follows the host filesystem: `Guide.md` and `guide.md` are different files on a case-sensitive filesystem.
- Relative targets are resolved against the containing Markdown file and may point outside the supplied paths; the tool checks those targets as well.
- Explicit symlink inputs are followed. During a directory walk, symlinked files and directories are skipped. A target's existence check uses `stat`, which follows symlinks.
- Backslash escapes are used while finding the end of a destination, but are not removed from the destination text before it is checked: `[x](docs/a\)b.md)` is checked for a file named `a\)b.md`.
- An empty inline destination (`[x]()` or `![x]()`) is ignored. An empty reference definition destination (`[label]: <>`) makes every use resolve to an empty target, which is skipped.
- YAML front matter is not recognised; link-like syntax inside it is scanned as ordinary Markdown.
- HTTP(S) and other external targets are never fetched or validated.

## Development

```bash
npm test         # builds, then runs the Vitest suite
npm run typecheck
npm run build
npm ls --omit=dev  # runtime dependency check: must be empty
```

The package has no runtime dependencies; TypeScript and Vitest are development dependencies only.
