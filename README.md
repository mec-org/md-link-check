# md-link-check

md-link-check is an offline CLI that finds broken relative links, images and heading anchors in a repository's Markdown. It is the software factory's pilot app: small, low-stakes, and checked against real docs. v0.1 is a CLI only, with no runtime dependencies.

See [PROJECT.md](PROJECT.md) for the charter, [ROADMAP.md](ROADMAP.md) for the milestones and [CONTRIBUTING.md](CONTRIBUTING.md) for who may open issues and pull requests.

> **Status: v0.1's checks, the M4 raw HTML forms, the M5 opt-in external checking contract and the M6 bounded transport and persistent cache are implemented.** Inline and reference-style links and images, heading anchors, explicit `<a id>`/`<a name>` anchors, raw HTML `<a href>` links and `<img src>` images, stable text output, `--json`, the documented exit codes, and bounded `--external` network checking with a persistent result cache are implemented. The remaining v0.2 milestone (the M7 GitHub Action) is not implemented yet. The release decision is the owner's. See [Current limitations](#current-limitations).

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
md-link-check [--json] [--external] [--] <path...>
md-link-check --help
node dist/cli.js README.md docs/    # without npm link
```

Pass one or more files or directories. An explicit file is checked as given, even if its name does not end in `.md`; a directory is searched recursively for `.md` and `.markdown` files (the extension is matched case-insensitively). Traversal is deterministic; `.git` and `node_modules` directories are skipped, and symlinked entries found during a walk are not followed. Targets are resolved relative to the Markdown file that contains the link.

Options:

- `--json` writes one JSON document to standard output instead of text output;
- `--external` opts in to network checking of `http:` and `https:` targets with Node's built-in `fetch`. Without it, external targets are counted as skipped and the tool makes no network requests. With it, requests, retries, redirects and the persistent result cache have documented finite bounds; see [Opt-in external checking](#opt-in-external-checking);
- `--help` (or `-h`) prints usage and the exit codes and exits `0`;
- `--` ends option parsing, so a path beginning with `-` can be checked.

`--json` and `--external` may be repeated; repeated flags are accepted idempotently.

Text mode writes diagnostics and a final summary to standard output. In text mode, usage errors and internal failures are written to standard error. With `--json`, a check run writes only the JSON document to standard output. `--help` always prints the help text to standard output and exits `0`, even when `--json` is also given. The process exit code is the same in both modes.

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

With `--external`, checked external occurrences are not labeled skipped, and a second summary line reports the external counts:

```text
Checked 1 file: 1 broken target, 0 external links skipped.
External checks: 2 occurrences, 2 distinct targets checked (1 succeeded, 1 failed), 1 broken occurrence.
```

Text diagnostics and both summary lines keep the M5 shape. Cache hit, miss and stale counts are reported additively only in `--json` (`external.cache`), not in text output.

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
  "external": {
    "enabled": false,
    "occurrences": 3,
    "skipped": 3,
    "distinctChecked": 0,
    "succeeded": 0,
    "failed": 0,
    "brokenOccurrences": 0,
    "cache": {
      "enabled": false,
      "hits": 0,
      "misses": 0,
      "stale": 0
    },
    "results": []
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
  "external": {
    "enabled": false,
    "occurrences": 3,
    "skipped": 3,
    "distinctChecked": 0,
    "succeeded": 0,
    "failed": 0,
    "brokenOccurrences": 0,
    "results": []
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
- `error`: present only for a usage error or an internal failure; contains `kind` (`"usage"` or `"internal"`) and `message`, and `diagnostics` is empty in that case;
- `summary.filesChecked`: number of unique files checked;
- `summary.broken`: number of diagnostics (broken targets and undefined reference uses);
- `summary.externalSkipped`: number of skipped HTTP(S) link and image uses; `0` when `--external` is enabled;
- `external`: additive external-check summary and per-target results, present in every report; `enabled` is `false` when the run was offline. `cache` is additive and reports whether persistent caching was configured plus this run's hit, miss and stale-entry counts. See [JSON additions](#json-additions);
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
  "external": {
    "enabled": false,
    "occurrences": 0,
    "skipped": 0,
    "distinctChecked": 0,
    "succeeded": 0,
    "failed": 0,
    "brokenOccurrences": 0,
    "cache": {
      "enabled": false,
      "hits": 0,
      "misses": 0,
      "stale": 0
    },
    "results": []
  },
  "diagnostics": []
}
```

An internal failure that prevents checking from completing keeps the same top-level shape: `ok` is `false`, `exitCode` is `2`, the counts are zero, `diagnostics` is empty, and `error.kind` is `"internal"` with a short message. It never escapes as a stack trace or an unhandled rejection. The two kinds are distinguishable without parsing prose.

## Exit codes

- `0`: checking completed and no broken targets were found;
- `1`: checking completed and at least one broken target was found;
- `2`: usage error (no input paths, an unknown option, or an input path that cannot be read), or an internal failure that prevented checking from completing; the JSON `error.kind` distinguishes the two.

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
- `http:` and `https:` targets are skipped and counted once per use by default; with `--external` they are checked once per distinct normalized target;
- a fragment resolves against the heading anchors and explicit anchors of the same Markdown file or an existing relative Markdown file;
- a missing file or anchor produces the existing `target does not exist` or `anchor does not exist` diagnostic and exit `1`;
- the target is preserved as written, and the diagnostic line is the line containing the opening tag.

These uses flow through the existing text and JSON reporters and exit codes: a document with only valid explicit anchors and raw HTML targets exits `0`, a broken raw HTML target or explicit anchor exits `1`, and usage errors remain exit `2`. Text diagnostics keep the `file:line: target — reason` form, and the JSON report keeps every existing field and adds the `external` object described in [JSON additions](#json-additions).

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

By default these targets are skipped and never fetched:

- HTTP and HTTPS URLs (checked only when `--external` is given), and other URI schemes such as `mailto:`;
- root-relative targets such as `/docs/guide.md`.

Fenced code blocks (backtick and tilde fences) and indented code blocks at the top level, and single-line inline code, are ignored by the scanner for links, images, reference definitions, headings and supported raw HTML tags, so examples inside them do not produce diagnostics, do not define references or anchors and are not counted as external uses.

## External link count

Without `--external`, `summary.externalSkipped` and the text summary count every encountered `http:` or `https:` link and image use that is skipped, including inline uses, resolved reference-style uses and supported raw HTML uses. The count is per use, not per unique destination, so the same URL used three times counts three. An unused external reference definition is not counted.

Other URI schemes (`mailto:`, `ftp:`), protocol-relative targets (`//example.com`) and root-relative targets are skipped but are not included in the HTTP(S) count. Without `--external`, no destination is fetched and the tool never opens a network connection.

With `--external`, external occurrences are checked instead of skipped: `summary.externalSkipped` and the text `external links skipped` count are `0`, and the external summary counts in the text output and JSON describe what was checked. See [Opt-in external checking](#opt-in-external-checking).

## Opt-in external checking

`--external` is the only way the CLI performs network access. Without it, HTTP(S) targets are skipped and counted as above: the tool performs no request, no DNS lookup and no `fetch` call. With it, each distinct `http:` or `https:` target is checked with Node's built-in `fetch`; no fetch library and no runtime dependency are added.

External checking is opt-in because it sends requests to the hosts named in the Markdown. Use it only when the run may access those hosts.

### Occurrences, deduplication and shared results

Every supported, non-code external occurrence is collected: inline Markdown links and images, resolved reference-style links and images, and raw HTML `<a href>` links and `<img src>` images. Unused reference definitions and external-looking text inside fenced, indented or inline code are not collected. Each occurrence keeps its source file, line, column, link or image kind, and the target exactly as written.

Targets are deduplicated before any cache lookup or request scheduling. The deduplication key is the normalized URL produced by `new URL(target.trim()).href` with its fragment removed: scheme and host normalization applies, paths and queries stay distinct, `http:` and `https:` targets are never merged, and URLs that differ only by fragment share one check. The fragment is never sent in the HTTP request. The first occurrence determines the normalized `target` reported in structured results, which keeps its fragment when one was written. One check is shared by every occurrence of the same network target, even when the source spellings differ.

If one distinct target fails, every supported source occurrence of it receives a diagnostic, while only one external check was performed. Diagnostics preserve the original target spelling at each source occurrence.

If a target previously classified as HTTP(S) cannot be parsed by `new URL` (for example `http://`), it is reported as a failed external target without a request.

### HTTP contract

These are finite internal defaults in M6, not CLI flags:

- request method: `GET`, not `HEAD`;
- success: final status `200` through `399`;
- failure: final status `400` through `599`, an exhausted timeout or network failure, or a redirect failure;
- timeout: 5 seconds per attempt, with a fresh `AbortController` signal per attempt. The timer starts when the attempt's first request actually runs and covers the rest of that attempt's redirect chain;
- attempts: 2 total, the initial attempt plus one retry;
- retried outcomes: network failures, timeouts, status `408`, status `429`, and status `500` through `599`;
- not retried: statuses `400` through `499` other than `408` and `429`, and redirect failures;
- retry delay: none (0 ms, the documented ceiling);
- global concurrency: at most 4 requests in flight across all hosts;
- per-host politeness: at most 1 request in flight per host origin (scheme, hostname and effective port), with no mandatory per-host start delay (0 ms). An internal testing seam clamps any configured delay to a finite 1-second ceiling;
- redirects: followed explicitly with `fetch`'s manual redirect mode for statuses `301`, `302`, `303`, `307` and `308` when a `Location` header is present. At most 5 redirects are followed per attempt, so one attempt makes at most 6 requests and one target makes at most 12 requests across its 2 attempts. Relative locations resolve against the current URL; only `http:` and `https:` destinations without credentials are followed. A missing `Location` leaves the 3xx status as the final response, which counts as success under the status rule;
- scheduling: one bounded scheduler is shared by initial attempts, retries and redirect hops, so all three obey the global and per-host limits. Scheduling is completion-driven and leaves no polling loop, interval or unbounded timer.

A successful final response is not a broken link, including one reached through redirects or a retryable failure that later succeeds. Results and diagnostics are deterministic: distinct target results are ordered by first source occurrence, and diagnostics keep their existing file and document order regardless of response completion order. No partial output is written before all checks finish.

The tool validates the HTTP outcome only. It does not crawl or recursively check fetched pages, validate page content, authenticate, persist cookies, configure a proxy or handle `robots.txt`. It does not send a custom user agent or credentials. The only cross-invocation state is the bounded result cache described next.

### Persistent result cache

`--external` also uses a persistent cache of distinct-target outcomes. Without `--external` the cache is never read or written; a usage error before checking also performs no cache I/O. The cache is not configurable by a CLI flag.

Location, by platform:

- Linux, macOS and other Unix-like systems: `$XDG_CACHE_HOME/md-link-check/external-v1.json` when `XDG_CACHE_HOME` is an absolute path, otherwise `~/.cache/md-link-check/external-v1.json` when the home directory is absolute;
- Windows: `%LOCALAPPDATA%\md-link-check\external-v1.json`;
- when no safe user-cache directory can be determined, caching is disabled for that run; the tool never writes a cache under the repository, the current directory or `.project/`.

The cache is one versioned JSON document with schema version `1`:

```json
{
  "version": 1,
  "entries": {
    "https://example.test/path": {
      "checkedAt": "2026-11-02T00:00:00.000Z",
      "outcome": "succeeded",
      "httpStatus": 200,
      "finalUrl": "https://example.test/path",
      "attempts": 1
    }
  }
}
```

Each entry stores only the normalized cache key, a finite `checkedAt` timestamp, a recognized `outcome` (`succeeded` or `permanent-failure`), an optional bounded `httpStatus`, an optional sanitized `finalUrl`, and a finite `attempts` count. Response bodies, headers, cookies, raw errors, stack traces, source occurrence lists and arbitrary server content are never stored.

The cache key is the same normalized network URL used for deduplication, with the fragment removed: HTTP and HTTPS, hostname, effective port, path and query are all significant, source file paths are never part of the key, and credential-bearing URLs are checked but never persisted or used for a cache hit.

Freshness and invalidation:

- an entry is fresh when its schema is valid, its timestamp is finite, its age is not greater than 24 hours, and its outcome is recognized and cacheable. The boundary is inclusive: an entry exactly 24 hours old is still fresh;
- a future-dated entry is treated as fresh only within a 60-second clock skew; beyond that it is ignored and refreshed, so a future timestamp cannot stay fresh indefinitely;
- a stale entry is ignored for results and triggers exactly one live refresh per distinct target. It is replaced only when that refresh yields a cacheable final result;
- automatic expiry is the 24-hour freshness period. Deleting the cache file clears the cache. A schema-version mismatch invalidates the whole document; changing URL normalization or the schema requires a new version or invalidation. There is no cache-clearing CLI flag.

Cacheable outcomes are successful final responses and permanent, non-retryable 4xx HTTP failures. Timeouts, network failures, exhausted retryable statuses (`408`, `429`, `500`-`599`), redirect failures and unparseable targets are not cached, so a transient outage is never persisted as an authoritative failure. A cache hit recreates the same substantive outcome without a request: it keeps the same status, HTTP status, final URL and failure classification, and its `attempts` is `0` because no request was made in that invocation. A cached permanent failure produces the same broken-link diagnostic and exit code as the equivalent live result.

Malformed, truncated, oversized, wrong-version, wrong-type or unreadable cache data is treated as empty: live checks proceed, checked pages are not turned into findings, no stack trace is printed, and a new valid document may replace the unusable one after successful checking. Invalid individual entries are ignored without discarding valid entries in the same document. A cache write failure is non-fatal: it never adds a diagnostic, changes a clean result into a broken link, or turns a usage success into exit `2`; the run simply does not persist that update.

Writes are bounded and atomic. Parent directories are created with restrictive defaults where supported, a bounded temporary file is written in the same directory and renamed over the cache path, and the temporary file is removed on failure. Stale and excess entries are pruned before serialization, keys are written in sorted order so equivalent cache states produce identical files, and one invocation performs at most one write. Cross-process locking is not implemented, but atomic replacement prevents a partial document from becoming the visible cache.

The documented bounds are a 5 MiB cache file, at most 10,000 entries, and at most 8 KiB for a cache key or final URL. Writers prune stale entries, truncate excess entries (newest first) and shrink the document to fit the byte bound. Readers reject an oversized file without parsing it, cap the number of entries they inspect, and validate every field's type and recognized value.

### Diagnostics

Every failed source occurrence keeps the existing form `file:line: target — reason`. The reasons are stable and contain no error stacks, socket identifiers, absolute paths or secrets:

- `external HTTP 404` for a terminal HTTP status;
- `external HTTP 500 after 2 attempts` for a retried status that exhausted the attempts;
- `external request timed out after 2 attempts`;
- `external network failure after 2 attempts`;
- `external redirect limit exceeded after 5 redirects` when the redirect ceiling stops an attempt;
- `external invalid redirect target` when a `Location` is missing a usable HTTP(S) URL;
- `external invalid URL`.

A successful distinct target produces no broken-link diagnostic.

### Exit codes and text summary

Exit codes keep their documented meanings:

- `0`: checking completed and neither local nor enabled external broken links were found;
- `1`: at least one local or enabled external broken link was reported;
- `2`: usage error, or an internal failure that prevented checking from completing.

Without `--external`, unreachable external targets remain skipped and do not change the exit status. With `--external`, failed external checks produce diagnostics and therefore exit `1`, while successful checks do not change an otherwise clean status. Network failures are findings, not usage errors. Usage errors, including an unknown option or no input paths, still exit `2` and perform no network access. An internal failure is also reported through the structured text or JSON result and exits `2` without a stack trace.

The first text summary line keeps its pre-M5 form and meaning. With `--external`, checked occurrences are not labeled skipped, and a second line reports external occurrences, distinct targets checked, successes, failures and broken occurrences; see [Text output](#text-output).

### JSON additions

The JSON schema keeps `version` 1 and every existing top-level and nested field, name, type and meaning. A new top-level `external` object is always present. `enabled` records whether `--external` was supplied; without it, `occurrences` and `skipped` equal the existing skipped count and `results` is empty. With it, for example:

```json
{
  "version": 1,
  "ok": false,
  "exitCode": 1,
  "summary": {
    "filesChecked": 1,
    "broken": 2,
    "externalSkipped": 0
  },
  "external": {
    "enabled": true,
    "occurrences": 3,
    "skipped": 0,
    "distinctChecked": 2,
    "succeeded": 1,
    "failed": 1,
    "brokenOccurrences": 2,
    "cache": {
      "enabled": true,
      "hits": 0,
      "misses": 2,
      "stale": 0
    },
    "results": [
      {
        "target": "http://127.0.0.1:12345/ok",
        "status": "succeeded",
        "attempts": 1,
        "httpStatus": 200,
        "finalUrl": "http://127.0.0.1:12345/ok",
        "source": "network"
      },
      {
        "target": "http://127.0.0.1:12345/not-found",
        "status": "failed",
        "attempts": 1,
        "httpStatus": 404,
        "finalUrl": "http://127.0.0.1:12345/not-found",
        "failureKind": "http",
        "source": "network"
      }
    ]
  },
  "diagnostics": [
    {
      "file": "docs/guide.md",
      "line": 12,
      "column": 5,
      "kind": "link",
      "target": "http://127.0.0.1:12345/not-found",
      "reason": "external HTTP 404"
    },
    {
      "file": "docs/guide.md",
      "line": 20,
      "column": 3,
      "kind": "image",
      "target": "http://127.0.0.1:12345/not-found",
      "reason": "external HTTP 404"
    }
  ]
}
```

The external properties are:

- `external.enabled`: whether external checking was enabled for this run;
- `external.occurrences`: number of supported HTTP(S) source occurrences discovered;
- `external.skipped`: occurrences skipped when checking is disabled; always `0` when it is enabled;
- `external.distinctChecked`: number of distinct normalized targets checked;
- `external.succeeded`, `external.failed`: distinct target outcomes;
- `external.brokenOccurrences`: source occurrences reported as broken through failed targets;
- `external.cache`: additive cache counters, present in every report. `enabled` is whether a persistent cache document was configured; `hits` is the number of distinct targets answered from a fresh entry; `misses` is the number with no usable entry; `stale` is the number whose entry was ignored and refreshed. All are `0` without `--external`, and the absolute cache path is never exposed;
- `external.results`: one object per distinct checked target, in first-occurrence order, containing `target` (the first occurrence's normalized URL or the trimmed unparseable target), `status` (`succeeded` or `failed`), `attempts` (the number of attempts made in this invocation; `0` for a cache hit), `httpStatus` and `finalUrl` only when a response was received, `failureKind` only for failures (`http`, `timeout`, `network`, `redirect`, `invalid-redirect` or `invalid-url`), `redirectCount` only when a redirect ceiling stopped an attempt, and `source` (`cache` or `network`) only for checked targets when persistent caching is active. No raw error objects are exposed.

`summary.broken` remains the number of diagnostics, so external broken occurrences contribute to it when `--external` is enabled. Existing consumers can ignore `external` and every pre-M5 field keeps its name, type and meaning; the version is not incremented because the change is additive and optional. Usage-error JSON reports the requested `enabled` value with zero counts, disabled cache counters and an empty `results` array, and never claims that external checks ran. JSON mode writes exactly one document to standard output with no progress text.

### Privacy and offline use

With `--external`, each distinct external target receives a `GET` request, which reveals the target URL and the runner's IP address to that host and to network intermediaries, subject to their logging and rate limits. Do not enable it for private documents or in an environment that must stay offline. Omitting the flag keeps a run fully offline, so offline CI remains possible. The test suite never contacts the public internet: external-check tests use local loopback HTTP fixtures on ephemeral ports.

The persistent cache also stores the normalized URLs you checked, including queries, together with their outcomes and timestamps, in your user cache directory so a later `--external` run can avoid those requests. The cache contains no response bodies, headers, cookies or credentials, and credential-bearing URLs are never persisted; deleting the cache file clears it. If URLs in your documents contain sensitive query strings, be aware that those URLs are written to that local cache. Without `--external` no cache file is read or written.

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

The step fails the job with exit `1` when a broken target is found and exit `2` on a usage error. Add `--json` and redirect standard output when a machine-readable report is needed as an artifact; the report is written before the process exits. The example stays fully offline; add `--external` only when the job may access the network, because without it HTTP(S) targets are counted as skipped and never requested.

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
- Without `--external`, HTTP(S) and other external targets are never fetched. With `--external`, only the HTTP(S) URL outcome is validated: fetched page content, authentication, cookies, proxies, `robots.txt`, recursive crawling and other URI schemes remain unsupported.
- The external cache is shared by every document checked by the same user account: the key is the network URL only, so the same URL is cached across repositories. There is no CLI flag to inspect, clear or bypass the cache, and no cross-process lock; delete the cache file to clear it. A URL with a sensitive query string is stored locally as part of its cache key, though credential-bearing URLs are never persisted.
- Redirect handling follows the five statuses listed above. A 3xx response with no `Location` is treated as a successful final response by the existing 200-399 success rule. A redirect target containing credentials is rejected rather than followed.
- The request timeout starts when an attempt's first request actually runs, so time spent waiting for a global or per-host scheduling slot is not counted against the timeout; the queue itself is finite because every target, retry and redirect hop is bounded.

## Development

```bash
npm test         # builds, then runs the Vitest suite
npm run typecheck
npm run build
npm ls --omit=dev  # runtime dependency check: must be empty
```

The package has no runtime dependencies; TypeScript and Vitest are development dependencies only. The test suite does not contact the public internet: tests that exercise real network behavior use local loopback HTTP fixtures on ephemeral ports, and the rest inject a fetch stub.
