/**
 * M19 follow-up scope guard that runs without git history.
 *
 * The M14 permitted-path test proves that the M19 packet changed only allowed
 * paths, but it is skipped when its authorized M14 base commit is unavailable,
 * which is the case in a shallow CI checkout. These checks run in CI and
 * enforce the two M19 scope requirements directly: the formatter stays outside
 * every other production module (and therefore outside the action and CLI
 * execution path), and the committed action bundle is byte-for-byte the
 * pre-summary v0.3 bundle recorded by the M17 fixture manifest.
 *
 * This is an M19 scope guard: the M20 integration milestone will change the
 * action bundle and will deliberately retire or update the bundle checks.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(REPO_ROOT, 'src');
const FORMATTER_MODULE = join(SOURCE_DIR, 'summary-markdown.ts');
const ACTION_BUNDLE = join(REPO_ROOT, 'action-dist', 'index.cjs');
const M17_MANIFEST = join(
  REPO_ROOT,
  'test',
  'fixtures',
  'm17-v03',
  'manifest.json',
);

/** Every TypeScript source file under `src/`, in deterministic path order. */
function productionSources(): string[] {
  const files: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(path);
      }
    }
  };

  walk(SOURCE_DIR);
  return files.sort();
}

describe('M19 scope', () => {
  it('keeps the formatter out of every other production module', () => {
    const otherSources = productionSources().filter(
      (path) => path !== FORMATTER_MODULE,
    );
    expect(otherSources.length).toBeGreaterThan(0);

    for (const path of otherSources) {
      const source = readFileSync(path, 'utf8');
      const displayPath = relative(REPO_ROOT, path);
      // No production module imports or references the M19 module or its
      // exports, so no action or CLI path can reach the formatter.
      expect(source, displayPath).not.toContain('summary-markdown');
      expect(source, displayPath).not.toContain('formatRunSummaryMarkdown');
      expect(source, displayPath).not.toContain('SUMMARY_DIAGNOSTIC_LIMIT');
    }
  });

  it('keeps the formatter out of the committed action bundle', () => {
    const bundle = readFileSync(ACTION_BUNDLE, 'utf8');

    expect(bundle).not.toContain('formatRunSummaryMarkdown');
    expect(bundle).not.toContain('SUMMARY_DIAGNOSTIC_LIMIT');
    expect(bundle).not.toContain('## Results');
    expect(bundle).not.toContain('## Diagnostics');
    expect(bundle).not.toContain('total diagnostics');
  });

  it('leaves the action bundle byte-identical to the pre-summary v0.3 bundle', () => {
    const manifest = JSON.parse(readFileSync(M17_MANIFEST, 'utf8')) as {
      source?: { actionBundleSha256?: string };
    };
    const expectedSha256 = manifest.source?.actionBundleSha256;
    expect(typeof expectedSha256).toBe('string');

    const actualSha256 = createHash('sha256')
      .update(readFileSync(ACTION_BUNDLE))
      .digest('hex');
    expect(actualSha256).toBe(expectedSha256);
  });
});
