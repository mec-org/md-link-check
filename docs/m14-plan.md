# M14 plan and assumptions

- Milestone: M14 — Exit and usage interaction (`ROADMAP.md`)
- Issue: #38
- Authorized base: `be1c58084966d8003a48d687b028451c0a7c7b03`
- Exact starting `HEAD`: `be1c58084966d8003a48d687b028451c0a7c7b03`
- Starting worktree: clean. `git status --porcelain` printed nothing in the
  isolated worktree created directly from that commit.
- Branch: `agent/exit-usage-interaction-2e60415fbf42`

## Plan

One focused pull request of approximately one day of work. M14 is an
interaction-hardening milestone, so the plan is a test-only packet:

1. Record the established orchestration, exit source and M12/M13 contracts from
   source and tests before changing anything.
2. Add a focused action-level interaction matrix proving the structured
   `RunResult` remains authoritative while annotations and summary outputs are
   active: exits 0, 1 and 2; broken-run annotation and output retention;
   usage-error policy; rendering failures; direct-CLI isolation; loopback-only
   external interaction.
3. Add in-packet artifact, scope and zero-runtime-dependency evidence.
4. Keep production behavior unchanged: `src/`, `action.yml`,
   `action-dist/index.cjs`, `README.md`, `.github/` and `.project/` are not
   modified. The committed artifact stays current and reproducible.

The packet is confined to one pull request: the M14 test suite plus this plan
record. No new feature, input, output, exit code, workflow, tag, release or npm
publication is part of the milestone.

## Assumptions

- The M14 requirement is interaction hardening, not new behavior. Tracing the
  orchestration demonstrated no interaction defect, so regression coverage is
  the delivery rather than a production change.
- The committed `m9-broken` fixture (nine findings across two files) is
  representative for broken-run annotation and output retention.
- External interaction can be exercised only through the repository's loopback
  fixture server and fetch guards; no real network access is needed.
- GitHub's `GITHUB_OUTPUT` environment-file protocol is the published
  `name=value` record form that the implementation writes.

## Confidence

- High that the outcomes are correct: exits 0, 1 and 2, unchanged CLI bytes,
  and annotation/output retention all passed under Node 22 locally and in CI.
- High that no production behavior changed: the production sources, action
  metadata, committed bundle, README, `.github/` and `.project/` are untouched.
- Medium that a one-day estimate is representative across environments; the
  work is test-only and depends on no network access or hosted-runner feature.

## Facts that could change the plan

- A demonstrated interaction defect in the orchestration would require a focused
  production fix and change the packet from test-only to code plus tests.
- A new M13 output, action input, exit code, CLI text change or artifact format
  change would require different assertions and is outside M14's boundaries.
- A runner change to `GITHUB_OUTPUT` handling or to annotation workflow-command
  semantics would require revisiting the protocol assertions.
- A shallow CI checkout cannot reconstruct the authorized base. The packet
  records the exact starting HEAD here and keeps a full-history path check that
  skips only when history is unavailable; the repository's committed baseline
  manifest still proves protected-directory scope in that mode.

## Verification record

- `npm ci`, `npm test`, `npm run typecheck`, `npm run build`,
  `npm run build:action`, `npm run check:action` and `npm ls --omit=dev` are run
  under Node 22 before handoff.
- The full-history path check lists only the M14 test suite and this plan
  record as changed relative to the authorized base.
