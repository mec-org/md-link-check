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
 * - the committed action bundle contains the M20 integration and is frozen to
 *   an exact recorded SHA-256, just as the M19 guard froze the pre-summary v0.3
 *   bundle, so any unexpected bundle change fails here. The in-packet
 *   `action-dist/index.cjs is current` test and the established
 *   `test/m15-committed-artifact.test.ts` / `test/m16-artifact-scope.test.ts`
 *   checks prove the same bundle is a fresh build of current source; this guard
 *   adds no competing build mechanism.
 */
import { createHash } from 'node:crypto';
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

/**
 * SHA-256 of the reviewed M20 action bundle. The M19 guard froze the exact
 * pre-summary v0.3 bundle by comparing against the M17 fixture manifest; M20
 * intentionally changes the bundle, so it records the exact M20 bytes instead
 * of replacing the equality check with a "differs from v0.3" check. Any
 * unexpected bundle change fails this guard; the next milestone that
 * deliberately regenerates the bundle revises this constant in the same PR.
 */
const M20_ACTION_BUNDLE_SHA256 =
  'b1221582b18b38ee207ae0d633ab06077e1cb95373910ab846d145743e78a95e';

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

  it('keeps the committed M20 action bundle byte-identical to the reviewed bundle', () => {
    const actualSha256 = createHash('sha256')
      .update(readFileSync(ACTION_BUNDLE))
      .digest('hex');
    expect(actualSha256).toBe(M20_ACTION_BUNDLE_SHA256);
  });
});
