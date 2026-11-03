import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOTATION_LIMITS,
  formatAnnotation,
  formatAnnotations,
  TRUNCATION_MARKER,
} from '../src/annotation.js';
import type { BrokenLinkResult } from '../src/run.js';
import {
  readActionArtifactText,
  readScopeReport,
  REPO_ROOT,
  runAction,
  runCli,
} from './action-helpers.js';
import {
  captureRun,
  fixtureRelativeFindings,
  M9_BROKEN_FINDINGS,
  M9_BROKEN_FIXTURE,
  M9_CLEAN_FIXTURE,
} from './m9-helpers.js';

const BASE_FINDING: BrokenLinkResult = Object.freeze({
  file: 'docs/guide.md',
  line: 14,
  target: 'missing.md',
  reason: 'target does not exist',
});

const BASE_ANNOTATION =
  '::error file=docs/guide.md,line=14::missing.md — target does not exist';

/** Formats a synthetic finding derived from the base example. */
function format(overrides: Partial<BrokenLinkResult> = {}): string {
  return formatAnnotation({ ...BASE_FINDING, ...overrides });
}

/** Splits one annotation into its properties and message for structural checks. */
function parts(annotation: string): {
  file: string;
  line: string;
  message: string;
} {
  const match = /^::error file=([^,]*),line=(\d+)::(.*)$/.exec(annotation);
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`unexpected annotation: ${annotation}`);
  }
  return {
    file: match[1],
    line: match[2],
    message: match[3],
  };
}

/** Reads a formatter-adjacent source file, for focused import-boundary guards. */
function readSource(file: string): string {
  return readFileSync(join(REPO_ROOT, 'src', file), 'utf8');
}

const FORMATTER_SOURCE = readSource('annotation.ts');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('annotation formatter core', () => {
  it('formats one workflow-command annotation for one broken link', () => {
    expect(format()).toBe(BASE_ANNOTATION);
    expect(format()).toMatch(/^::error file=/);
  });

  it('annotation includes the Markdown file property', () => {
    expect(format({ file: 'docs/guide with spaces.md' })).toBe(
      '::error file=docs/guide with spaces.md,line=14::missing.md — target does not exist',
    );
    expect(parts(format()).file).toBe('docs/guide.md');
  });

  it('annotation includes the one-based source line property', () => {
    expect(format({ line: 1 })).toBe(
      '::error file=docs/guide.md,line=1::missing.md — target does not exist',
    );
    expect(parts(format({ line: 42 })).line).toBe('42');
  });

  it('annotation message includes the original target', () => {
    expect(parts(format({ target: 'images/logo.png' })).message).toBe(
      'images/logo.png — target does not exist',
    );
  });

  it('annotation message includes the diagnostic reason', () => {
    expect(parts(format({ reason: 'anchor does not exist' })).message).toBe(
      'missing.md — anchor does not exist',
    );
  });

  it('one finding produces exactly one annotation', () => {
    const annotations = formatAnnotations([BASE_FINDING]);

    expect(annotations).toEqual([BASE_ANNOTATION]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).not.toMatch(/[\r\n]/);
  });

  it('several findings produce one annotation each', () => {
    const annotations = formatAnnotations([
      BASE_FINDING,
      { file: 'a.md', line: 2, target: 'y', reason: 'second' },
      { file: 'b.md', line: 1, target: 'z', reason: 'third' },
    ]);

    expect(annotations).toHaveLength(3);
    for (const annotation of annotations) {
      expect(annotation).toMatch(/^::error file=.*,line=\d+::.*$/);
      expect(annotation).not.toMatch(/[\r\n]/);
    }
  });

  it('several findings preserve result order', () => {
    const annotations = formatAnnotations([
      { file: 'b.md', line: 8, target: 'x', reason: 'first' },
      { file: 'a.md', line: 2, target: 'y', reason: 'second' },
      { file: 'b.md', line: 1, target: 'z', reason: 'third' },
    ]);

    expect(annotations).toEqual([
      '::error file=b.md,line=8::x — first',
      '::error file=a.md,line=2::y — second',
      '::error file=b.md,line=1::z — third',
    ]);
  });

  it('zero findings produce no annotations', () => {
    expect(formatAnnotations([])).toEqual([]);
  });

  it('duplicate findings remain duplicate annotations', () => {
    const annotations = formatAnnotations([BASE_FINDING, BASE_FINDING]);

    expect(annotations).toEqual([BASE_ANNOTATION, BASE_ANNOTATION]);
    expect(annotations).toHaveLength(2);
  });

  it('formatter does not mutate findings', () => {
    const findings = Object.freeze([
      Object.freeze({ ...BASE_FINDING }),
      Object.freeze({ file: 'docs/other.md', line: 3, target: '#missing', reason: 'anchor does not exist' }),
    ]) as readonly BrokenLinkResult[];
    const before = JSON.stringify(findings);

    const annotations = formatAnnotations(findings);

    expect(annotations).toHaveLength(2);
    expect(JSON.stringify(findings)).toBe(before);
    expect(Object.isFrozen(findings)).toBe(true);
  });

  it('formatter is deterministic', () => {
    const finding = { ...BASE_FINDING };

    expect(formatAnnotation(finding)).toBe(formatAnnotation(finding));
    expect(formatAnnotations([finding, finding])).toEqual(
      formatAnnotations([finding, finding]),
    );
  });
});

describe('annotation formatter representative findings', () => {
  it('formats a missing file finding', () => {
    expect(
      format({
        file: 'docs/guide.md',
        line: 14,
        target: 'missing.md',
        reason: 'target does not exist',
      }),
    ).toBe('::error file=docs/guide.md,line=14::missing.md — target does not exist');
  });

  it('formats a missing image finding', () => {
    expect(
      format({
        file: 'docs/images.md',
        line: 4,
        target: 'images/logo.png',
        reason: 'target does not exist',
      }),
    ).toBe('::error file=docs/images.md,line=4::images/logo.png — target does not exist');
  });

  it('formats a missing anchor finding', () => {
    expect(
      format({
        file: 'docs/anchors.md',
        line: 27,
        target: '#deployment',
        reason: 'anchor does not exist',
      }),
    ).toBe('::error file=docs/anchors.md,line=27::#deployment — anchor does not exist');
  });

  it('formats a raw HTML target finding', () => {
    expect(
      format({
        file: 'index.md',
        line: 9,
        target: 'docs/raw-page.md',
        reason: 'target does not exist',
      }),
    ).toBe('::error file=index.md,line=9::docs/raw-page.md — target does not exist');
  });

  it('formats an enabled external failure finding', () => {
    expect(
      format({
        file: 'README.md',
        line: 12,
        target: 'https://example.com/missing',
        reason: 'external HTTP 404',
      }),
    ).toBe(
      '::error file=README.md,line=12::https://example.com/missing — external HTTP 404',
    );
  });
});

describe('annotation formatter escaping', () => {
  it('message escapes percent', () => {
    expect(parts(format({ target: '100%' })).message).toBe(
      '100%25 — target does not exist',
    );
  });

  it('message escapes carriage return', () => {
    expect(parts(format({ target: 'a\rb' })).message).toBe(
      'a%0Db — target does not exist',
    );
  });

  it('message escapes newline', () => {
    expect(parts(format({ reason: 'line1\nline2' })).message).toBe(
      'missing.md — line1%0Aline2',
    );
  });

  it('file property escapes percent', () => {
    expect(parts(format({ file: 'docs/100%.md' })).file).toBe('docs/100%25.md');
  });

  it('file property escapes carriage return', () => {
    expect(parts(format({ file: 'docs/a\rb.md' })).file).toBe('docs/a%0Db.md');
  });

  it('file property escapes newline', () => {
    expect(parts(format({ file: 'docs/a\nb.md' })).file).toBe('docs/a%0Ab.md');
  });

  it('file property escapes colon', () => {
    expect(parts(format({ file: 'docs/a:b.md' })).file).toBe('docs/a%3Ab.md');
  });

  it('file property escapes comma', () => {
    expect(parts(format({ file: 'docs/a,b.md' })).file).toBe('docs/a%2Cb.md');
  });

  it('escaping percent occurs before other escapes', () => {
    expect(format({ target: '%\r\n', reason: '100%' })).toBe(
      '::error file=docs/guide.md,line=14::%25%0D%0A — 100%25',
    );
    expect(format({ file: 'docs/%2C\r.md' })).toBe(
      '::error file=docs/%252C%0D.md,line=14::missing.md — target does not exist',
    );
  });

  it('diagnostic text resembling a workflow command cannot inject another command', () => {
    const annotation = format({
      target: 'x\n::error file=injected.md,line=1::pwned',
      reason: 'boom',
    });

    expect(annotation).toBe(
      '::error file=docs/guide.md,line=14::x%0A::error file=injected.md,line=1::pwned — boom',
    );
    expect(annotation.split('\n')).toHaveLength(1);
    expect(annotation).not.toContain('\r');
  });

  it('newline in target produces one annotation', () => {
    const annotation = format({ target: 'a\nb' });

    expect(annotation).toBe(
      '::error file=docs/guide.md,line=14::a%0Ab — target does not exist',
    );
    expect(annotation.split('\n')).toHaveLength(1);
  });

  it('newline in reason produces one annotation', () => {
    const annotation = format({ reason: 'a\nb' });

    expect(annotation).toBe('::error file=docs/guide.md,line=14::missing.md — a%0Ab');
    expect(annotation.split('\n')).toHaveLength(1);
  });

  it('comma in file cannot inject another property', () => {
    expect(format({ file: 'docs/a.md,line=99' })).toBe(
      '::error file=docs/a.md%2Cline=99,line=14::missing.md — target does not exist',
    );
    expect(parts(format({ file: 'docs/a.md,line=99' })).line).toBe('14');
  });

  it('ordinary Unicode remains readable', () => {
    expect(
      format({ file: 'docs/日本語.md', target: 'ガイド.md', reason: 'target does not exist' }),
    ).toBe(
      '::error file=docs/日本語.md,line=14::ガイド.md — target does not exist',
    );
  });
});

describe('annotation formatter bounds', () => {
  it('annotation accepts values below the documented limit', () => {
    const file = 'a'.repeat(ANNOTATION_LIMITS.file - 1);

    expect(format({ file })).toBe(
      `::error file=${file},line=14::missing.md — target does not exist`,
    );
  });

  it('annotation accepts values at the documented limit', () => {
    const file = 'a'.repeat(ANNOTATION_LIMITS.file);

    expect(format({ file })).toBe(
      `::error file=${file},line=14::missing.md — target does not exist`,
    );
  });

  it('annotation bounds values above the documented limit', () => {
    const file = 'a'.repeat(ANNOTATION_LIMITS.file + 1);
    const bounded = `${'a'.repeat(ANNOTATION_LIMITS.file - 1)}${TRUNCATION_MARKER}`;

    expect(format({ file })).toBe(
      `::error file=${bounded},line=14::missing.md — target does not exist`,
    );
    expect(parts(format({ file })).file).toHaveLength(ANNOTATION_LIMITS.file);
  });

  it('bounded message remains one workflow command', () => {
    const target = 't'.repeat(ANNOTATION_LIMITS.target);
    const reason = 'r'.repeat(ANNOTATION_LIMITS.reason);
    const expectedMessage =
      `${target} — ${'r'.repeat(ANNOTATION_LIMITS.message - target.length - 3 - 1)}` +
      TRUNCATION_MARKER;
    const annotation = format({ target, reason });

    expect(parts(annotation).message).toBe(expectedMessage);
    expect(parts(annotation).message).toHaveLength(ANNOTATION_LIMITS.message);
    expect(annotation.split('\n')).toHaveLength(1);
    expect(annotation).toMatch(/^::error file=docs\/guide\.md,line=14::/);
  });

  it('escaped file property stays within the documented bound', () => {
    const fileProperty = parts(format({ file: '%'.repeat(2_000) })).file;

    expect([...fileProperty].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.file);
    // Truncation never leaves a partial escape sequence behind.
    expect(fileProperty).toMatch(/^(?:%25)*…$/);
  });

  it('escaped target stays within the documented bound', () => {
    const target = '\n'.repeat(ANNOTATION_LIMITS.target);
    const message = parts(format({ target })).message;
    const targetPart = message.slice(0, message.indexOf(' — '));

    expect([...targetPart].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.target);
    expect(targetPart).toMatch(/^(?:%0A)*…$/);
  });

  it('escaped message stays within the documented bound', () => {
    const reason = '\n'.repeat(ANNOTATION_LIMITS.reason);
    const annotation = format({ reason });
    const message = parts(annotation).message;

    expect([...message].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.message);
    expect(annotation.split('\n')).toHaveLength(1);
    expect(message).toMatch(/^missing\.md — (?:%0A)*…$/);
  });

  it('bounded formatting is deterministic', () => {
    const finding: BrokenLinkResult = {
      file: 'f'.repeat(ANNOTATION_LIMITS.file + 10),
      line: 5,
      target: 't'.repeat(ANNOTATION_LIMITS.target + 10),
      reason: 'r'.repeat(ANNOTATION_LIMITS.reason + 10),
    };

    expect(formatAnnotation(finding)).toBe(formatAnnotation(finding));
  });

  it('annotation formatting does not truncate the structured result', () => {
    const finding: BrokenLinkResult = Object.freeze({
      file: 'f'.repeat(ANNOTATION_LIMITS.file + 10),
      line: 5,
      target: 't'.repeat(ANNOTATION_LIMITS.target + 10),
      reason: 'r'.repeat(ANNOTATION_LIMITS.reason + 10),
    });

    formatAnnotation(finding);

    expect(finding.file).toHaveLength(ANNOTATION_LIMITS.file + 10);
    expect(finding.target).toHaveLength(ANNOTATION_LIMITS.target + 10);
    expect(finding.reason).toHaveLength(ANNOTATION_LIMITS.reason + 10);
    expect(finding.line).toBe(5);
  });

  it('annotation bound does not split a surrogate pair', () => {
    const file = `${'a'.repeat(ANNOTATION_LIMITS.file - 1)}😀b`;
    const fileProperty = parts(format({ file })).file;
    const accepted = format({ file: `${'a'.repeat(ANNOTATION_LIMITS.file - 1)}😀` });

    expect(fileProperty).toBe(
      `${'a'.repeat(ANNOTATION_LIMITS.file - 1)}${TRUNCATION_MARKER}`,
    );
    expect(fileProperty).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(fileProperty).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // The same value without the trailing character is exactly at the limit, so
    // the surrogate pair is accepted whole rather than counted as two units.
    expect(accepted).toContain('😀');
  });
});

describe('annotation formatter separation from execution', () => {
  it('formatter performs no output', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');

    formatAnnotations([BASE_FINDING]);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('formatter does not read environment variables', () => {
    expect(FORMATTER_SOURCE).not.toMatch(/\bprocess\.env\b/);

    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(REPO_ROOT, 'should-not-be-read.md'));
    vi.stubEnv('INPUT_PATHS', 'ignored');
    const withEnvironment = formatAnnotation(BASE_FINDING);
    vi.unstubAllEnvs();

    expect(withEnvironment).toBe(BASE_ANNOTATION);
  });

  it('formatter does not inspect the filesystem', () => {
    expect(FORMATTER_SOURCE).not.toMatch(
      /node:fs|readFileSync|readdirSync|statSync|existsSync|lstatSync/,
    );
    expect(format({ file: 'does/not/exist.md' })).toBe(
      '::error file=does/not/exist.md,line=14::missing.md — target does not exist',
    );
  });

  it('formatter does not invoke link discovery', () => {
    const imports = [...FORMATTER_SOURCE.matchAll(/from\s+'([^']+)'/g)].map(
      (match) => match[1],
    );

    expect(imports).toEqual(['./run.js']);
    expect(FORMATTER_SOURCE).toContain(
      "import type { BrokenLinkResult } from './run.js';",
    );
    expect(FORMATTER_SOURCE).not.toMatch(
      /discoverMarkdownFiles|checkMarkdown|scanMarkdown|scanHtml|collectDocumentAnchors|classifyTarget/,
    );
  });

  it('formatter does not invoke network access', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    formatAnnotations([BASE_FINDING]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(FORMATTER_SOURCE).not.toMatch(/\bfetch\b|node:http|node:https|node:net/);
  });

  it('CLI output remains free of workflow-command annotations', async () => {
    const text = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const json = await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE });

    expect(text.status).toBe(1);
    expect(text.stdout).not.toContain('::error');
    expect(text.stdout).not.toMatch(/^::[a-z-]+/m);
    expect(text.stderr).not.toContain('::error');
    expect(json.status).toBe(1);
    expect(json.stdout).not.toContain('::error');
    expect(json.stdout).not.toMatch(/^::[a-z-]+/m);
  });

  it('action output remains free of workflow-command annotations in M10', async () => {
    const action = await runAction({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
    });
    const output = `${action.stdout}${action.stderr}`;

    expect(action.status).toBe(1);
    expect(output).toContain('README.md:3: docs/missing.md — target does not exist');
    expect(output).not.toContain('::error');
    expect(output).not.toMatch(/^::[a-z-]+/m);
  });

  it('formatter is not wired into runAction', async () => {
    const action = await runAction({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(action.status).toBe(1);
    expect(`${action.stdout}${action.stderr}`).not.toContain('::error');
    expect(readActionArtifactText()).not.toContain('formatAnnotation');
    for (const file of ['action-runner.ts', 'action.ts']) {
      const source = readSource(file);
      expect(source).not.toMatch(/formatAnnotation|annotation\.js/);
    }
  });

  it('formatter is separate from CLI reporting', () => {
    for (const file of ['run.ts', 'report.ts', 'cli.ts']) {
      const source = readSource(file);
      expect(source).not.toMatch(/formatAnnotation|annotation\.js/);
    }
  });
});

describe('M10 compatibility with the M9 structured result', () => {
  it('M9 structured findings format without adaptation', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const findings = fixtureRelativeFindings(result.diagnostics, M9_BROKEN_FIXTURE);

    const annotations = formatAnnotations(findings);

    expect(result.exitCode).toBe(1);
    expect(annotations).toHaveLength(M9_BROKEN_FINDINGS.length);
    expect(annotations[0]).toBe(
      '::error file=README.md,line=3::docs/missing.md — target does not exist',
    );
  });

  it('formatter preserves the M9 result order', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const annotations = formatAnnotations(
      fixtureRelativeFindings(result.diagnostics, M9_BROKEN_FIXTURE),
    );
    const expected = M9_BROKEN_FINDINGS.map(
      ({ file, line, target, reason }) =>
        `::error file=${file},line=${line}::${target} — ${reason}`,
    );

    expect(annotations).toEqual(expected);
  });

  it('formatter uses the same file line target and reason as M9', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const annotations = formatAnnotations(
      fixtureRelativeFindings(result.diagnostics, M9_BROKEN_FIXTURE),
    );

    for (const [index, finding] of M9_BROKEN_FINDINGS.entries()) {
      const annotation = annotations[index] ?? '';
      const match = /^::error file=(.*),line=(\d+)::(.*)$/.exec(annotation);

      expect(match).not.toBeNull();
      expect(match?.[1]).toBe(finding.file);
      expect(match?.[2]).toBe(String(finding.line));
      expect(match?.[3]).toBe(`${finding.target} — ${finding.reason}`);
    }
  });

  it('clean M9 result formats no annotation', async () => {
    const result = await captureRun([M9_CLEAN_FIXTURE]);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(formatAnnotations(result.diagnostics)).toEqual([]);
  });

  it('usage-error M9 result formats no annotation', async () => {
    const result = await captureRun([]);

    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(formatAnnotations(result.diagnostics)).toEqual([]);
  });
});

describe('M10 artifact and scope', () => {
  it('M10 changes no path under github metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('M10 changes no path under project metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('M10 adds no workflow', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/workflows/'))).toEqual([]);
  });
});
