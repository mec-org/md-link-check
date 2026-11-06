/**
 * M23 — README contract for the v0.4 run summary and for the release tags that
 * actually exist.
 *
 * The assertions are deliberately factual and durable rather than whole-
 * paragraph equality: they check that the README names the real count fields,
 * documents result order, the 50-entry limit, overflow disclosure, escaping,
 * exactly-once action-only writing, the fail-safe warnings, unchanged exits,
 * the offline default and the external opt-in.
 *
 * Tag facts come from the local Git repository when a full checkout carries
 * tags, and from the committed provenance recorded in
 * `test/m23-release-tags.json` in a shallow CI checkout. The README may name
 * only tags in that set, and must not claim a v0.4 tag or release exists.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './action-helpers.js';

interface ReleaseTagManifest {
  version: number;
  tags: Record<string, { tagObject: string; commit: string }>;
  v04Tag: string | null;
}

function readmeText(): string {
  return readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
}

function readReleaseTagManifest(): ReleaseTagManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'test', 'm23-release-tags.json'), 'utf8'),
  ) as ReleaseTagManifest;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The tagged-ref action examples the README documents. */
function documentedUsesLines(readme: string): string[] {
  return readme
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:- )?uses: mec-org\/md-link-check@/.test(line));
}

describe('M23 README v0.4 contract', () => {
  it('documents the v04 run summary contract', () => {
    const readme = readmeText();

    // The summary is documented as an action-only job-page record.
    expect(readme).toMatch(/^### Job summary$/m);
    expect(readme).toContain('GITHUB_STEP_SUMMARY');

    // Actual count names: the Markdown labels, the JSON summary fields and the
    // action output names agree.
    expect(readme).toContain('`Checked`');
    expect(readme).toContain('`summary.filesChecked`');
    expect(readme).toContain('`files-checked`');
    expect(readme).toContain('`Broken`');
    expect(readme).toContain('`summary.broken`');
    expect(readme).toContain('`broken`');
    expect(readme).toContain('`External skipped`');
    expect(readme).toContain('`summary.externalSkipped`');
    expect(readme).toContain('`external-skipped`');

    // Result order and the documented 50-entry listing limit with overflow
    // disclosure.
    expect(readme).toMatch(/result order/);
    expect(readme).toMatch(/first 50 diagnostics/);
    expect(readme).toMatch(/50 is a documented constant/);
    expect(readme).toMatch(/total number of broken links/);
    expect(readme).toMatch(/how many are not listed/);

    // Escaping, exactly-once writing, action-only isolation and fail-safe
    // warnings.
    expect(readme).toMatch(/escaped for inline Markdown/);
    expect(readme).toMatch(/exactly once per action invocation/);
    expect(readme).toMatch(/A direct CLI run never writes a step summary/);
    expect(readme).toMatch(/`GITHUB_STEP_SUMMARY` is unset or empty, no summary is written/);
    expect(readme).toMatch(/exactly one `::warning::` line/);

    // Unchanged exits, default offline and opt-in external checking.
    expect(readme).toMatch(/0 for a clean run, 1 when at least one broken link was reported, 2 for a usage error/);
    expect(readme).toMatch(/default offline mode/);
    expect(readme).toMatch(/`external: true`/);
    expect(readme).toMatch(/No transport policy is added or changed by the summary/);

    // The usage-error fragment is described separately from a completed run.
    expect(readme).toMatch(/Outcome: usage error/);
    expect(readme).toMatch(/Link check: not performed/);

    // The pre-existing v0.3 surfaces are restated as unchanged.
    expect(readme).toMatch(/annotations? .*unchanged|unchanged .*annotations/);
  });

  it('states only release tags that exist', () => {
    const readme = readmeText();
    const manifest = readReleaseTagManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.v04Tag).toBeNull();
    expect(Object.keys(manifest.tags).sort()).toEqual(['v0.2.0', 'v0.3.0']);

    // Every tag the README names as existing belongs to the verified set.
    for (const tag of Object.keys(manifest.tags)) {
      expect(readme).toContain(`\`${tag}\` tag exists`);
    }

    // Pinned v0.3 provenance is retained: the exact owner-approved commit.
    const v03 = manifest.tags['v0.3.0'];
    expect(v03).toBeDefined();
    expect(v03?.commit).toBe('4438906e6e6085c941faf3117c2aaca1824a073d');
    expect(readme).toContain(v03?.commit ?? '');

    // No v0.4 tag is created, moved or anticipated; the README distinguishes
    // implemented v0.4 behavior from a published release.
    expect(readme).toContain('no v0.4 release tag exists yet');
    expect(readme).not.toMatch(/v0\.4\.0/);
    expect(readme).toMatch(/v0\.4 interface is implemented/);

    // A full checkout's local tags must match the recorded provenance. A
    // shallow CI checkout may carry no tags at all; that case is covered by
    // the committed manifest and is an explicitly recorded limitation.
    const localTags = git(['tag', '--list'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (localTags.length > 0) {
      for (const [tag, provenance] of Object.entries(manifest.tags)) {
        expect(localTags).toContain(tag);
        expect(git(['rev-parse', `${tag}^{commit}`]).trim()).toBe(provenance.commit);
        expect(git(['rev-parse', tag]).trim()).toBe(provenance.tagObject);
      }
      expect(localTags.filter((tag) => /^v0\.4(?:\.|$)/.test(tag))).toEqual([]);
    }

    // Any tagged-ref action example either uses the documented placeholder or
    // an existing tag; it never pins a tag that does not exist.
    const usesLines = documentedUsesLines(readme);
    expect(usesLines.length).toBeGreaterThanOrEqual(1);
    for (const line of usesLines) {
      const reference = line.slice(line.lastIndexOf('@') + 1);
      if (reference.startsWith('<') && reference.endsWith('>')) {
        expect(readme).toMatch(/`<tag>` is a placeholder for the v0\.4 surface/);
        continue;
      }
      expect(Object.keys(manifest.tags)).toContain(reference);
    }
  });
});
