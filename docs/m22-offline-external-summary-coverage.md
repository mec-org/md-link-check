# M22 — Offline and external-mode summary coverage

Base: `ffae299e251ebf7d793214e0ec83e6f27bf0f827` (M20 follow-up, #57).

M22 is a coverage milestone: it proves at the action level that the appended job
summary mirrors the existing run in both network modes, without establishing new
transport semantics. No production code changed and the committed
`action-dist/index.cjs` bundle is unchanged.

## Modes covered

| Mode | Canonical input | Transport | Fixture |
| --- | --- | --- | --- |
| Default offline | `external` omitted (or `"false"`) | none; HTTP(S) targets are counted as skipped | local links plus one `http:` and one `https:` loopback target |
| External | `external: "true"` (`INPUT_EXTERNAL=true`) | existing opt-in HTTP(S) checking | the same local links plus a test-owned loopback server |

The action input is the only switch. There is no environment-variable shortcut
and no second transport implementation.

## Default offline no-network proof

`test/m22-summary-modes.test.ts` runs the committed `action-dist/index.cjs`
bundle with `INPUT_PATHS` naming the fixture files, `INPUT_EXTERNAL` omitted, a
temporary `GITHUB_OUTPUT` and a temporary `GITHUB_STEP_SUMMARY`. The child is
started through the existing `runArtifactUnderOfflineGuard` helper with
`test/offline-guard.cjs` preloaded. That guard records and refuses every
practical network entry point (`fetch`, Node HTTP/HTTPS clients, HTTP/2, raw
sockets, TLS, DNS) and every filesystem access beneath the audit cache root.

The fixture contains one `http://127.0.0.1:<ephemeral>/ok` target and one
`https://127.0.0.1:<ephemeral>/secure` target. The assertions are:

- the guard log does not exist, so no guarded network or audit-cache API was
  even attempted;
- the test-owned server received no request;
- exit `1`, the exact CLI text, the exact annotation lines and the exact output
  records are the established offline result;
- the summary counts are `Checked: 2`, `Broken: 3`, `External skipped: 2`, the
  two external targets are only skipped (no invented broken finding), and the
  writable destination receives exactly one summary with no warning.

A server request count alone is not used as the proof: the guard log is the
positive evidence that no transport attempt happened, including any target the
fixture might have contained. The guard's own liveness is exercised by the
existing M15 offline-guard control test (`offline guard control observes network
access`).

## External-mode loopback proof

External tests set the canonical `INPUT_EXTERNAL=true` and use
`startFixtureServer()` from `test/server.ts`:

- the server calls `listen(0, '127.0.0.1')`, so the operating system assigns an
  ephemeral port;
- every fixture URL is built from the actual bound `http://127.0.0.1:<port>`
  address; the fixture contains no public URL, DNS name or fallback target;
- the existing routes are used: `/ok` (healthy, `200`) and `/not-found`
  (broken, `404`, terminal and not retried under the existing policy);
- requests are recorded with method and path, and the expected request count is
  exactly two `GET` requests, one per distinct target;
- the child runs with `test/action-fetch-guard.cjs`, whose log records every
  HTTP(S) attempt before allowing loopback or refusing anything else. Exactly two
  `allowed` loopback entries are expected, the logged origins equal the fixture
  server origin, no `refused` entry may exist, and the fixture's only external
  targets are the two server URLs;
- the server is closed in unconditional `finally` cleanup and every connection is
  destroyed; the test asserts `server.closed` is true.

## Cache and environment isolation

- Every external invocation uses a fresh temporary `XDG_CACHE_HOME`; the
  external-mode test asserts the cache document was created beneath that
  temporary location. No test reads or writes a real user cache.
- The in-process source invocation sets `XDG_CACHE_HOME` for the duration of the
  run and restores it (and the working directory) in `finally`.
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lowercase forms
  are removed from both the child environment and the in-process run, so host
  proxy configuration cannot redirect fixture traffic.
- The shared action helpers delete inherited `INPUT_*` variables and the
  runner-owned `GITHUB_OUTPUT`/`GITHUB_STEP_SUMMARY` paths; M22 supplies its own
  writable temporary files and never relies on host GitHub environment values.
- The suite-wide `test/setup.ts` already runs every test with a private temporary
  cache home and a loopback-only fetch guard.

## Result-to-summary consistency

Both modes are checked through the real action path with a temporary
`GITHUB_STEP_SUMMARY` file. The committed bundle provides the customer-visible
bytes; the in-process `runAction` orchestration seam provides the authentic M17
`RunResult` for the counts and ordered findings. The hard-coded oracles below are
not produced by the production formatter.

Offline fixture (2 files):

- `README.md:4: docs/missing.md` — target does not exist;
- `README.md:7: #no-such-heading` — anchor does not exist;
- `docs/guide.md:4: not-there.md` — target does not exist;
- counts `{ filesChecked: 2, broken: 3, externalSkipped: 2 }`.

External fixture (2 files):

- `README.md:3` healthy `/ok` is checked successfully;
- `README.md:4` broken `/not-found` yields `external HTTP 404` at document order
  position 1;
- `README.md:5` missing local target and `docs/guide.md:4` missing local target
  follow in document order;
- counts `{ filesChecked: 2, broken: 3, externalSkipped: 0 }`.

Assertions in both modes:

- the structured run's three counts equal the summary's count lines;
- the summary's listed diagnostics equal the run's ordered broken findings, one
  entry per finding, retaining file, line, target and reason;
- existing classifications and reason strings are unchanged;
- M18 escaping is authoritative: the `#` and `-` characters in the offline
  targets render as `\#no\-such\-heading` / `not\-there.md`, and the external
  target's `:` and `-` characters render as `http\://127.0.0.1\:PORT/not\-found`;
- the M19 runtime count guard accepts the authentic result (no formatter error
  and no warning), and M19's 50-diagnostic limit and overflow disclosure are
  covered by the existing `test/action-summary-integration.test.ts`, which stays
  green;
- summary generation adds or removes no finding: the listed count equals
  `summary.broken` equals `findings.length`;
- exactly one summary is appended (`## Results` occurs once) and no
  `::warning::` line is emitted for the writable destination.

## No additional transport from the summary

`summary generation performs no additional external request` freezes the existing
transport behavior: two distinct targets produce exactly two `GET` requests
(`/ok` and `/not-found`) and two fetch-guard entries. The summary is formatted and
appended only after `run(...)` returns. Re-reading the summary and the transport
evidence still shows two requests; no fetch, retry or cache revalidation is
added. The terminal `404` deliberately produces one attempt, not two, and the
frozen count of two proves the summary path added none.

## Preserved action surfaces

`both summary modes preserve established action surfaces` runs the committed
bundle once per mode and asserts byte-for-byte, in order:

- the human-readable CLI text (diagnostics followed by the existing summary
  lines, including the enabled-external second line);
- the workflow-command annotation lines, in the run's finding order;
- the three `GITHUB_OUTPUT` records (`files-checked`, `broken`,
  `external-skipped`) and their order;
- exit `1` for both broken fixtures and an empty stderr;
- the summary as the only addition, appended exactly once, with no warning.

Nothing in the summary is printed to stdout or stderr.

## Tests

`test/m22-summary-modes.test.ts` contains exactly the six named
responsibilities:

1. `default offline action attempts no HTTP or HTTPS request`
2. `default offline summary matches the run`
3. `external action uses only a loopback server`
4. `external summary matches the run`
5. `summary generation performs no additional external request`
6. `both summary modes preserve established action surfaces`

The existing `test/m15-helpers.ts` offline-guard helper gained an optional
`environment` argument so a guarded invocation can also supply its temporary
`GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY`; the audit cache root still wins over
any inherited cache home.

`test/m14-exit-usage-interaction.test.ts` lists later milestones' files
explicitly so its own authorized-base check keeps running on later branches.
That list gained the two M22 paths (`test/m22-summary-modes.test.ts` and
`docs/m22-offline-external-summary-coverage.md`) exactly as earlier milestones
added theirs; no rule, hash or tag assertion was weakened.

## Assumptions found false or resolved

- The loopback fixture server, the child-process loopback fetch guard, the
  offline no-network guard and the temporary-cache seam already existed and were
  reused (`test/server.ts`, `test/action-fetch-guard.cjs`,
  `test/offline-guard.cjs`, the `cacheHome`/`XDG_CACHE_HOME` option), so no new
  guard or server harness was added.
- The canonical external input is `INPUT_EXTERNAL=true` for the action input
  `external: "true"` (or `--external` for the CLI); tests use exactly that
  representation and no production-inaccessible shortcut.
- There is no standalone temporary-cache helper: the supported production seam
  is `XDG_CACHE_HOME`, which every external invocation points at a fresh
  temporary directory. The suite-wide `test/setup.ts` already supplies a private
  temp cache home for the in-process path.
- The in-process action's external cache is resolved from `process.env` rather
  than the environment object passed to `runAction`, so the in-process source
  run isolates and restores `XDG_CACHE_HOME` (and the process working directory)
  around the call.
- The offline guard helper could not previously supply runner-owned files for
  the same invocation; it was extended with one optional `environment` argument
  instead of adding a parallel guard harness.
- No summary-reporting mismatch appeared in either mode, so no production code
  changed. The committed bundle is therefore byte-identical to a fresh build.
- No transport ambiguity required a decision: `/ok` (200) and `/not-found`
  (404, terminal) already have frozen classifications and reason strings, and
  the offline HTTP(S) targets already have the frozen skipped treatment.


## Charter pins and v0.3 tag

M22 changes no owner-approved charter file. `test/charter-pins.ts`,
`test/m16-artifact-scope.test.ts`, and the pinned v0.3 artifact checks remain
green, and the `v0.3.0` tag is neither moved nor recreated. Only `test/` and
`docs/` paths changed.

## Bundle regeneration

No production module changed, so the action build is byte-identical to the
committed bundle. The established commands were run anyway:

```bash
npm run build:action   # regenerate action-dist/index.cjs (no diff)
npm run check:action   # fail if the committed bundle is stale
```

## Verification

```bash
npm run typecheck
npm test
npm run build:action
npm run check:action
node scripts/check-scope.mjs
```

Results in this checkout (Node 26.12.0; CI runs the same suite on Node 22):

- `npm run typecheck` — passed;
- `npm test` — 59 test files, 1338 tests passed (the `pretest` TypeScript
  build ran first);
- `npm run build:action` — built `action-dist/index.cjs`; the committed bundle
  is byte-identical, so no artifact diff;
- `npm run check:action` — `action entrypoint is reproducible:
  action-dist/index.cjs`;
- `node scripts/check-scope.mjs` — passed in `git-diff` mode: no change under
  `.github/` or `.project/` relative to the authorized base;
- `git hash-object PROJECT.md ROADMAP.md` — matches the pinned
  `CHARTER_FILE_PINS`; `v0.3.0` still points at
  `4438906e6e6085c941faf3117c2aaca1824a073d`.

The repeated full-suite runs were made sequentially; concurrent Vitest
invocations of this repository contend for the same build outputs and are not
used as evidence.

