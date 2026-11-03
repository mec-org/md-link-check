# md-link-check

md-link-check is an offline CLI that finds broken relative links, images and heading anchors in a repository's Markdown. It is the software factory's pilot app: small, low-stakes, and checked against real docs. v0.1 is a CLI only, with no runtime dependencies; v0.2 adds HTML anchors and raw HTML links, opt-in external checks and a GitHub Action, still with no runtime dependencies. v0.3 adds CI-facing results to the GitHub Action: an annotation for each broken link and summary-count outputs, with the CLI unchanged.

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

## Scope (v0.2.0)

v0.2 retains all v0.1 behavior and supported Markdown forms, as defined by the v0.1 scope, and adds exactly three capabilities:

- **Explicit HTML anchors and raw HTML targets:** recognize `<a id="…">` and `<a name="…">` as anchor targets, and check raw HTML `<a href="…">` links and `<img src="…">` images by the same local-target and external-target rules used for Markdown.
- **Opt-in external URLs:** `--external` checks HTTP and HTTPS targets using Node's built-in `fetch`. The default remains fully offline and counts external URLs as skipped. External checking has finite timeouts, bounded concurrency, per-host politeness, bounded retries and a persistent result cache. Node's built-in `fetch`, with no runtime dependency, is an irreversible implementation decision.
- **GitHub Action:** root-level action metadata and a checked-in action entrypoint wrap the CLI and can be consumed from a tagged ref of this repository without an npm release or a repository workflow.

The human-readable diagnostic remains `file:line: target — reason`. Without `--external`, exit codes remain unchanged: 0 for no broken links, 1 for at least one broken link, and 2 for a usage error. With `--external`, a terminal external HTTP error, timeout or network failure is a broken link and therefore contributes to exit code 1; usage errors still exit 2. The `--json` schema is extended only additively with external-check summary counts and an external-result classification; existing fields are not removed or renamed.

## Scope (v0.3.0)

v0.3 retains all v0.1 and v0.2 behavior and adds CI-facing results to the existing GitHub Action, and nothing else:

- **Annotations:** for each broken-link diagnostic the CLI reports, the action emits one GitHub workflow-command annotation carrying the Markdown file, the source line and the diagnostic message. Values that workflow commands treat specially are escaped, so each finding stays exactly one annotation.
- **Summary outputs:** the action publishes the run's summary counts as action outputs declared in `action.yml`, one for each existing JSON summary field: `summary.filesChecked`, `summary.broken` and `summary.externalSkipped`.
- **An unchanged CLI:** the action still prints the CLI's own output line for line; annotations and outputs are additional records. Direct CLI runs emit no workflow command and need no GitHub Actions environment. The `file:line: target — reason` diagnostic, exit codes 0, 1 and 2, the `--json` schema, the CLI options and the action's `paths` and `external` inputs are unchanged.

The default stays fully offline, tests use no real network (external-mode tests use a local HTTP server fixture only), and v0.3 adds no runtime dependency. Every source change regenerates the checked-in `action-dist/index.cjs` with the existing build script.

## Non-goals

- External URL checking unless `--external` is explicitly supplied.
- Network access during ordinary unit or CI tests; external-check tests use only a local HTTP server fixture.
- Raw HTML processing beyond <a id>, <a name>, <a href> and <img src>.
- Executing scripts, interpreting the DOM, or discovering targets generated dynamically by HTML or JavaScript.
- A supported library API.
- Anchor rules other than GitHub's heading-slug rule plus exact explicit HTML anchor names.
- A generated workflow, changes under `.github/` or `.project/`, or automatic installation of the action into another repository.
- An npm release or npm-based action distribution.
- Publishing a release, creating a release tag, or enabling external checks against real internet targets without the owner's decision.
- Annotations or workflow commands from direct CLI runs, or any need for a GitHub Actions environment outside the action (v0.3).
- New action inputs, an ignore or suppression mechanism, or new external transport, cache or retry controls (v0.3).
- Wider Markdown or raw HTML parsing, such as block quotes, HTML comments, front matter, autolinks or multiline constructs (v0.3).
- A v0.3 milestone that changes `package.json`, a lockfile, `scripts/`, `PROJECT.md` or `ROADMAP.md`.

## Canonical terminology

- **broken link** → a Markdown link or image whose target file, directory or heading does not exist. Not "dead link" or "bad link".
- **target** → what a link points to: a file or directory path, optionally with an anchor. Not "destination" or "href".
- **anchor** → the `#fragment` of a link, naming a heading. Not "hash" or "bookmark".
- **outside contributor** → any GitHub user who is not a collaborator on this repo.

## Irreversible decisions

- **This repo is public.** Its history can be cloned and cached, so never commit secrets, credentials, tenant data or personal data.
- **No runtime dependencies.** A parser dependency would need the factory's dependency check and the owner's approval.
- **The CLI is the supported surface,** and from v0.2 the GitHub Action that wraps it. Output format and exit codes are the contract; changes to them are additive.

## Open questions

- None blocking implementation.
- Whether and when to publish the package to npm remains an owner decision outside v0.2.
- Whether and when to create the v0.2 release tag remains an owner decision after the definition of done is satisfied.
- Whether and when to create the v0.3 release tag remains an owner decision after the v0.3 definition of done is satisfied.

## Definition of done (v0.1)

1. Fixture tests cover every supported form, with no false positives inside code blocks or inline code.
2. Exit codes 0, 1 and 2 and the `--json` output are tested.
3. In a run over the owner's `dsh-copilot` docs, every reported broken link is confirmed real.
4. CI is green on `main`, and the README documents usage and the unsupported forms.

When all four hold, the mission stops and the release decision goes to the owner.

## Definition of done (v0.2)

1. Fixture tests cover supported <a id>, <a name>, <a href> and <img src> forms, including attribute order, case, quoting, local targets, anchors and exclusions inside fenced, indented and inline code, with all v0.1 fixtures still passing.
2. A test proves that a run without `--external` makes zero network requests, counts HTTP and HTTPS targets as skipped, and preserves the v0.1 human-readable output, JSON fields and exit-code behavior.
3. Local HTTP server tests cover external success, redirects, permanent failures, retryable failures, retry exhaustion, timeouts and network errors without contacting the real network.
4. Automated tests demonstrate enforced timeout, concurrency, per-host politeness and retry ceilings, including completion under failure rather than an unbounded wait.
5. Automated tests demonstrate deduplication, a fresh cache hit, stale-cache refresh, and safe recovery from a missing or malformed cache; the cache location, key, freshness period and invalidation behavior are documented.
6. Exit codes 0, 1 and 2 are tested with and without `--external`; an exhausted external failure contributes to exit code 1, while invalid invocation contributes to exit code 2.
7. `--json` tests prove that external summary counts and result classification are additive, deterministic and documented, and that no existing v0.1 field is removed or renamed.
8. Root action metadata and its checked-in entrypoint are validated by a test or repository-local script; a clean fixture exits 0, a broken fixture exits 1, invalid input exits 2, and opt-in external checking works through the wrapper.
9. A reproducible-build check regenerates the action entrypoint and reports no diff, and a test proves that it resolves files correctly when invoked from outside the action repository as a tagged-ref action would be.
10. A fully offline run over the owner's `dsh-copilot` documentation completes, every reported local broken link is confirmed real, and the run leaves no untracked cache or generated file in the checked repository.
11. The README documents CLI and action usage, `--external`, external failure semantics, additive JSON fields, cache behavior, unsupported HTML forms, the fully offline default, and the absence of an npm release.
12. CI is green on `main`, no v0.2 milestone changes `.github/` or `.project/`, and the release and tag decision has been handed to the owner.

## Definition of done (v0.3)

1. M9–M16 are merged in order, one issue and one PR each, each within the factory's changed-line limit including `action-dist/index.cjs`.
2. Action-level tests prove that each broken link reported through the action produces exactly one workflow-command annotation carrying its Markdown file, source line and diagnostic message, in the CLI's result order, and that a clean run produces none.
3. Tests cover file names, targets and reasons containing characters that workflow commands treat specially; each still produces one annotation with its values intact.
4. For the covered fixtures, the action still prints the CLI's own output unchanged, line for line; annotations are additional records.
5. `action.yml` declares the summary-count outputs, and action-level tests prove that their values equal the run's `summary.filesChecked`, `summary.broken` and `summary.externalSkipped` for clean, broken and external-mode fixtures.
6. Direct CLI runs emit no workflow command and need no GitHub Actions environment.
7. Exit codes 0, 1 and 2, the CLI options, the `--json` fields and the action's `paths` and `external` inputs are unchanged, with and without `--external`; a usage error never becomes a broken-link annotation.
8. Tests use no real network; external-mode tests use a local HTTP server fixture only; the default stays offline.
9. No v0.3 milestone changes `package.json`, a lockfile, `scripts/`, `.github/`, `.project/`, `PROJECT.md` or `ROADMAP.md`; `action-dist/index.cjs` is current at every merge; CI is green on `main`.
10. The README documents the annotations, the outputs and the unchanged CLI output, and its release-tag statements match the tags that exist; then the v0.3 release and tag decision is handed to the owner.
