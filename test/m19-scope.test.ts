/**
 * Summary-integration scope guard that runs without git history.
 *
 * M19 introduced this guard while the formatter was deliberately unwired: no
 * production module other than `src/summary-markdown.ts` could mention it, and
 * the committed action bundle had to stay byte-identical to the pre-summary
 * v0.3 bundle. M20 is the milestone that wires the formatter into the action,
 * so its own docstring anticipated this update.
 *
 * The guard now enforces the narrow M20 integration edge directly, without git
 * history and therefore in a shallow CI checkout:
 *
 * - only `src/action-runner.ts` may import or mention the M19 formatter, and
 *   only it may read the `GITHUB_STEP_SUMMARY` destination;
 * - the formatter module itself stays pure, and the one append helper stays
 *   formatter-free;
 * - the committed action bundle contains the M20 integration, so the shipped
 *   artifact actually carries the formatter and the append path. Bundle
 *   freshness (the committed bytes equal a fresh build of current source) is
 *   proven by the in-packet `action-dist/index.cjs is current` test through the
 *   existing `scripts/build-action.mjs --check`, and kept by the established
 *   `test/m15-committed-artifact.test.ts` / `test/m16-artifact-scope.test.ts`
 *   checks; this guard hard-codes no generated hash and adds no competing build
 *   mechanism.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = join(REPO_ROOT, 'src');
const INTEGRATION_MODULE = join(SOURCE_DIR, 'action-runner.ts');
const FORMATTER_MODULE = join(SOURCE_DIR, 'summary-markdown.ts');
const STEP_SUMMARY_MODULE = join(SOURCE_DIR, 'action-step-summary.ts');
const ACTION_BUNDLE = join(REPO_ROOT, 'action-dist', 'index.cjs');

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

describe('M20 action-summary integration scope', () => {
  it('keeps the M19 formatter reachable only from the action integration point', () => {
    const sources = productionSources();
    expect(sources).toContain(INTEGRATION_MODULE);
    expect(sources).toContain(FORMATTER_MODULE);
    expect(sources).toContain(STEP_SUMMARY_MODULE);

    for (const path of sources) {
      const source = readFileSync(path, 'utf8');
      const displayPath = relative(REPO_ROOT, path);

      if (path === INTEGRATION_MODULE) {
        // The one permitted M20 edge: the action orchestration layer calls the
        // guarded formatter and the append helper.
        expect(source, displayPath).toContain("from './summary-markdown.js'");
        expect(source, displayPath).toContain('formatRunSummaryMarkdown');
        expect(source, displayPath).toContain("from './action-step-summary.js'");
        continue;
      }

      if (path === FORMATTER_MODULE) {
        // The formatter module itself owns the formatter and limit names; its
        // purity is asserted separately below. It still reads no environment
        // and performs no I/O.
        expect(source, displayPath).not.toContain('GITHUB_STEP_SUMMARY');
        expect(source, displayPath).not.toContain('action-step-summary');
        continue;
      }

      // Every other production module, including the direct CLI entrypoint and
      // the generic run logic, cannot reach the formatter or the summary
      // destination. The action-only append helper takes its destination and
      // already-formatted Markdown as arguments, so it names neither.
      expect(source, displayPath).not.toContain('summary-markdown');
      expect(source, displayPath).not.toContain('formatRunSummaryMarkdown');
      expect(source, displayPath).not.toContain('SUMMARY_DIAGNOSTIC_LIMIT');
      expect(source, displayPath).not.toContain('GITHUB_STEP_SUMMARY');
      expect(source, displayPath).not.toContain('action-step-summary');
    }
  });

  it('keeps the formatter pure and the append helper formatter-free', () => {
    const formatter = readFileSync(FORMATTER_MODULE, 'utf8');
    const appendHelper = readFileSync(STEP_SUMMARY_MODULE, 'utf8');

    expect(formatter).not.toMatch(/node:fs|node:os|process\.env|appendFile/);
    expect(appendHelper).not.toContain('formatRunSummaryMarkdown');
    expect(appendHelper).not.toContain('escapeSummaryValue');
    expect(appendHelper).not.toContain('GITHUB_STEP_SUMMARY');
    expect(appendHelper).toContain('appendFile');
  });

  it('ships the M20 integration in the committed action bundle', () => {
    const bundle = readFileSync(ACTION_BUNDLE, 'utf8');

    expect(bundle).toContain('formatRunSummaryMarkdown');
    expect(bundle).toContain('## Results');
    expect(bundle).toContain('## Diagnostics');
    expect(bundle).toContain('total diagnostics');
    expect(bundle).toContain('run summary counts and findings disagree');
    expect(bundle).toContain('GITHUB_STEP_SUMMARY');
  });
});
