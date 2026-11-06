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

    // The pre-existing v0.3 surfaces are restated as unchanged: the action's
    // printed diagnostics and annotations supplement, never replace, the CLI
    // output.
    expect(readme).toMatch(/The action prints the CLI's diagnostics and summaries unchanged/);
    expect(readme).toMatch(/Annotations and outputs are additional records/);
  });

  it('states only release tags that exist', () => {
    const readme = readmeText();
    const manifest = readReleaseTagManifest();
    expect(manifest.version).toBe(1);
    const recordedTags = Object.keys(manifest.tags);
    expect(recordedTags).toEqual(expect.arrayContaining(['v0.2.0', 'v0.3.0']));

    // A full checkout exposes the actual local tags; a shallow CI checkout may
    // carry none. Both sources feed the set of tags the README may name, so the
    // suite follows the tags that exist instead of banning a future tag.
    const localTags = git(['tag', '--list'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const knownTags = new Set([
      ...recordedTags,
      ...localTags,
      ...(manifest.v04Tag === null ? [] : [manifest.v04Tag]),
    ]);

    // Recorded provenance is verified against local Git when tags are
    // available. A shallow CI checkout has no tags; the committed manifest is
    // then the recorded evidence.
    if (localTags.length > 0) {
      for (const [tag, provenance] of Object.entries(manifest.tags)) {
        if (!localTags.includes(tag)) {
          continue;
        }
        expect(git(['rev-parse', `${tag}^{commit}`]).trim()).toBe(provenance.commit);
        expect(git(['rev-parse', tag]).trim()).toBe(provenance.tagObject);
      }
    }

    // Pinned v0.3 provenance is retained in the manifest and the README.
    const v03 = manifest.tags['v0.3.0'];
    expect(v03).toBeDefined();
    expect(v03?.commit).toBe('4438906e6e6085c941faf3117c2aaca1824a073d');
    expect(readme).toContain(v03?.commit ?? '');
    for (const tag of ['v0.2.0', 'v0.3.0']) {
      expect(readme).toContain(`\`${tag}\` tag exists`);
    }

    // Every tag the README presents as existing must actually exist.
    for (const match of readme.matchAll(/`(v\d+\.\d+\.\d+)` tag exists/g)) {
      const tag = match[1] ?? '';
      expect(knownTags.has(tag), `README claims nonexistent tag ${tag}`).toBe(true);
    }

    // When no v0.4 tag exists, the README says so and distinguishes implemented
    // behavior from a published release. Once the owner creates one, the
    // dynamic claim is allowed to follow the tag instead of failing the suite on
    // the owner's release decision.
    const v04Tags = [...knownTags].filter((tag) => /^v0\.4(?:\.|$)/.test(tag));
    if (v04Tags.length === 0) {
      expect(readme).toContain('no v0.4 release tag exists yet');
      expect(readme).toMatch(/v0\.4 interface is implemented/);
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
      expect(
        knownTags.has(reference),
        `README pins nonexistent tag ${reference}`,
      ).toBe(true);
    }
  });
});
