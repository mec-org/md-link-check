import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_LIMITS,
  formatAnnotation,
  formatAnnotations,
  TRUNCATION_MARKER,
} from '../src/annotation.js';
import type { Diagnostic } from '../src/checker.js';
import { formatDiagnostic, type JsonReport } from '../src/report.js';
import type { BrokenLinkResult } from '../src/run.js';
import {
  readActionArtifactText,
  readScopeReport,
  REPO_ROOT,
  runAction,
  runCli,
  type ProcessResult,
} from './action-helpers.js';
import {
  captureRun,
  fixtureRelativeFindings,
  M9_CLEAN_FIXTURE,
} from './m9-helpers.js';
import {
  decodeMessageData,
  decodePropertyValue,
  M11_SPECIAL_VALUES_FINDINGS,
  M11_SPECIAL_VALUES_FIXTURE,
  parseAnnotation,
} from './m11-helpers.js';

const SEPARATOR = ' — ';

const BASE_FINDING: BrokenLinkResult = Object.freeze({
  file: 'docs/guide.md',
  line: 14,
  target: 'missing.md',
  reason: 'target does not exist',
});

/** Formats a synthetic finding derived from the base example. */
function format(overrides: Partial<BrokenLinkResult> = {}): string {
  return formatAnnotation({ ...BASE_FINDING, ...overrides });
}

/** Expected annotations for the committed M11 fixture, in the CLI's order. */
const M11_EXPECTED_ANNOTATIONS = [
  '::error file=100%25.md,line=3::missing-target.md — target does not exist',
  '::error file=README.md,line=3::docs/100%25.md — target does not exist',
  '::error file=README.md,line=4::docs/a,b.md — target does not exist',
  '::error file=README.md,line=5::docs/a:b.md — target does not exist',
  '::error file=README.md,line=6::docs/::error.md — target does not exist',
  '::error file=README.md,line=7::docs/::warning.md — target does not exist',
  '::error file=README.md,line=8::docs/日本語.md — target does not exist',
  '::error file=README.md,line=9::docs/literal%250A.md — target does not exist',
  '::error file=README.md,line=10::docs/a=b"c.md — target does not exist',
  '::error file=comma%2Cfile.md,line=3::missing-target.md — target does not exist',
] as const;

/** Frozen byte-for-byte human-readable output for the M11 fixture. */
const M11_EXPECTED_TEXT_LINES = [
  '100%.md:3: missing-target.md — target does not exist',
  'README.md:3: docs/100%.md — target does not exist',
  'README.md:4: docs/a,b.md — target does not exist',
  'README.md:5: docs/a:b.md — target does not exist',
  'README.md:6: docs/::error.md — target does not exist',
  'README.md:7: docs/::warning.md — target does not exist',
  'README.md:8: docs/日本語.md — target does not exist',
  'README.md:9: docs/literal%0A.md — target does not exist',
  'README.md:10: docs/a=b"c.md — target does not exist',
  'comma,file.md:3: missing-target.md — target does not exist',
] as const;

const M11_EXPECTED_TEXT = `${M11_EXPECTED_TEXT_LINES.join('\n')}\nChecked 3 files: 10 broken targets, 0 external links skipped.\n`;

let cliRun: Promise<ProcessResult> | undefined;
let jsonRun: Promise<{ result: ProcessResult; document: JsonReport }> | undefined;

/** Runs the built CLI once over the M11 fixture with ordinary text output. */
function runM11Cli(): Promise<ProcessResult> {
  cliRun ??= runCli(['--', '.'], { cwd: M11_SPECIAL_VALUES_FIXTURE });
  return cliRun;
}

/** Runs the built CLI once over the M11 fixture in JSON mode. */
function runM11Json(): Promise<{ result: ProcessResult; document: JsonReport }> {
  jsonRun ??= runCli(['--json', '--', '.'], { cwd: M11_SPECIAL_VALUES_FIXTURE }).then(
    (result) => ({ result, document: JSON.parse(result.stdout) as JsonReport }),
  );
  return jsonRun;
}

/** Runs the checker in process and returns fixture-relative structured findings. */
async function m11Findings(): Promise<readonly BrokenLinkResult[]> {
  const result = await captureRun([M11_SPECIAL_VALUES_FIXTURE]);
  return fixtureRelativeFindings(result.diagnostics, M11_SPECIAL_VALUES_FIXTURE);
}

/** Finds one expected checker finding rather than asserting a non-null index. */
function findingFor(
  findings: readonly BrokenLinkResult[],
  predicate: (finding: BrokenLinkResult) => boolean,
  description: string,
): BrokenLinkResult {
  const finding = findings.find(predicate);
  if (finding === undefined) {
    throw new Error(`expected a checker finding for ${description}`);
  }
  return finding;
}

describe('M11 annotation parser oracle', () => {
  it('rejects duplicate required properties', () => {
    expect(() =>
      parseAnnotation('::error file=a.md,line=1,line=2::x — y'),
    ).toThrow(/duplicate annotation property "line"/);
  });

  it('rejects a missing required property', () => {
    expect(() => parseAnnotation('::error file=a.md::x — y')).toThrow(
      /missing the file or line property/,
    );
  });

  it('rejects a literal line terminator', () => {
    expect(() =>
      parseAnnotation(
        '::error file=a.md,line=1::x — y\n::error file=b.md,line=2::z — w',
      ),
    ).toThrow(/literal line terminator/);
  });
});

describe('M11 file property safety', () => {
  it('file property preserves a percent sign', () => {
    const file = 'docs/100%.md';
    const annotation = format({ file });
    const parsed = parseAnnotation(annotation);

    expect(annotation).toBe(
      '::error file=docs/100%25.md,line=14::missing.md — target does not exist',
    );
    expect(parsed.rawFile).toBe('docs/100%25.md');
    expect(decodePropertyValue(parsed.rawFile)).toBe(file);
    expect(parsed.file).toBe(file);
  });

  it('file property preserves a comma', () => {
    const file = 'docs/a,b.md';
    const annotation = format({ file });
    const parsed = parseAnnotation(annotation);

    expect(annotation).toContain('::error file=docs/a%2Cb.md,line=14::');
    expect(parsed.rawFile).toBe('docs/a%2Cb.md');
    expect(parsed.file).toBe(file);
  });

  it('file property preserves a colon', () => {
    const file = 'docs/a:b.md';
    const parsed = parseAnnotation(format({ file }));

    expect(parsed.rawFile).toBe('docs/a%3Ab.md');
    expect(parsed.file).toBe(file);
  });

  it('file property preserves a carriage return safely', () => {
    const file = 'docs/a\rb.md';
    const annotation = format({ file });
    const parsed = parseAnnotation(annotation);

    expect(parsed.rawFile).toBe('docs/a%0Db.md');
    expect(parsed.file).toBe(file);
    expect(annotation).not.toContain('\r');
    expect(parsed.physicalLines).toHaveLength(1);
  });

  it('file property preserves a newline safely', () => {
    const file = 'docs/a\nb.md';
    const annotation = format({ file });
    const parsed = parseAnnotation(annotation);

    expect(parsed.rawFile).toBe('docs/a%0Ab.md');
    expect(parsed.file).toBe(file);
    expect(annotation).not.toContain('\n');
    expect(parsed.physicalLines).toHaveLength(1);
  });

  it('file property preserves ordinary Unicode', () => {
    const file = 'docs/日本語.md';
    const parsed = parseAnnotation(format({ file }));

    expect(parsed.rawFile).toBe(file);
    expect(parsed.file).toBe(file);
  });

  it('file property preserves a literal percent escape sequence', () => {
    const file = 'docs/literal%0A.md';
    const parsed = parseAnnotation(format({ file }));

    expect(parsed.rawFile).toBe('docs/literal%250A.md');
    expect(parsed.file).toBe(file);
    expect(parsed.file).not.toContain('\n');
  });

  it('file property cannot inject another annotation property', () => {
    const file = 'docs/a.md,line=99';
    const annotation = format({ file });
    const parsed = parseAnnotation(annotation);

    expect(annotation).toBe(
      '::error file=docs/a.md%2Cline=99,line=14::missing.md — target does not exist',
    );
    expect(parsed.rawFile).toBe('docs/a.md%2Cline=99');
    expect(parsed.file).toBe(file);
    expect(parsed.line).toBe(14);
    expect(parsed.commandStartCount).toBe(1);
  });

  it('file property cannot inject another workflow command', () => {
    const file = 'docs/x\n::error file=injected.md,line=1::pwned';
    const annotation = format({ file });
    const parsed = parseAnnotation(annotation);

    expect(annotation).not.toMatch(/[\r\n]/);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
    expect(parsed.file).toBe(file);
  });

  it('decoded file property equals the bounded original value', () => {
    const file = '%,\n:'.repeat(1_000);
    const parsed = parseAnnotation(format({ file }));

    expect([...parsed.rawFile].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.file);
    expect(parsed.file.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(file.startsWith(parsed.file.slice(0, -TRUNCATION_MARKER.length))).toBe(true);
  });
});

describe('M11 target message safety', () => {
  it('annotation message preserves target percent', () => {
    const target = '100%';
    const parsed = parseAnnotation(format({ target }));

    expect(parsed.rawMessage).toBe('100%25 — target does not exist');
    expect(decodeMessageData(parsed.rawMessage)).toBe(
      `${target}${SEPARATOR}${BASE_FINDING.reason}`,
    );
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
  });

  it('annotation message preserves target carriage return safely', () => {
    const target = 'a\rb';
    const annotation = format({ target });
    const parsed = parseAnnotation(annotation);

    expect(parsed.rawMessage).toBe('a%0Db — target does not exist');
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
    expect(annotation).not.toContain('\r');
    expect(parsed.physicalLines).toHaveLength(1);
  });

  it('annotation message preserves target newline safely', () => {
    const target = 'a\nb';
    const annotation = format({ target });
    const parsed = parseAnnotation(annotation);

    expect(parsed.rawMessage).toBe('a%0Ab — target does not exist');
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
    expect(annotation).not.toContain('\n');
    expect(parsed.physicalLines).toHaveLength(1);
  });

  it('annotation message preserves target comma', () => {
    const target = 'docs/a,b.md';
    const parsed = parseAnnotation(format({ target }));

    expect(parsed.rawMessage).toBe(`docs/a,b.md${SEPARATOR}${BASE_FINDING.reason}`);
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
  });

  it('annotation message preserves target colon', () => {
    const target = 'docs/a:b.md';
    const parsed = parseAnnotation(format({ target }));

    expect(parsed.rawMessage).toBe(`docs/a:b.md${SEPARATOR}${BASE_FINDING.reason}`);
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
  });

  it('annotation message preserves target Unicode', () => {
    const target = 'docs/日本語.md';
    const parsed = parseAnnotation(format({ target }));

    expect(parsed.rawMessage).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
  });

  it('annotation message preserves target workflow-command-like text', () => {
    const target = 'docs/::error.md docs/::warning.md';
    const parsed = parseAnnotation(format({ target }));

    expect(parsed.rawMessage).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
  });

  it('annotation message preserves a literal target percent escape sequence', () => {
    const target = 'docs/literal%0A.md';
    const parsed = parseAnnotation(format({ target }));

    expect(parsed.rawMessage).toBe(
      `docs/literal%250A.md${SEPARATOR}${BASE_FINDING.reason}`,
    );
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
  });

  it('target cannot inject another workflow command', () => {
    const target = 'x\n::error file=injected.md,line=1::pwned';
    const annotation = format({ target });
    const parsed = parseAnnotation(annotation);

    expect(annotation).toBe(
      `::error file=docs/guide.md,line=14::x%0A::error file=injected.md,line=1::pwned${SEPARATOR}${BASE_FINDING.reason}`,
    );
    expect(annotation).not.toMatch(/[\r\n]/);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
    expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
  });

  it('decoded annotation message retains the bounded target', () => {
    const target = '\n'.repeat(ANNOTATION_LIMITS.target + 100);
    const parsed = parseAnnotation(format({ target }));
    const targetPart = parsed.message.slice(0, parsed.message.indexOf(SEPARATOR));
    const [rawTargetPart = ''] = parsed.rawMessage.split(SEPARATOR);

    expect(parsed.message.endsWith(`${SEPARATOR}${BASE_FINDING.reason}`)).toBe(true);
    expect([...rawTargetPart].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.target);
    expect(targetPart.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(target.startsWith(targetPart.slice(0, -TRUNCATION_MARKER.length))).toBe(true);
  });
});

describe('M11 reason message safety', () => {
  it('annotation message preserves reason percent', () => {
    const reason = '100% checked';
    const parsed = parseAnnotation(format({ reason }));

    expect(parsed.rawMessage).toBe(`missing.md${SEPARATOR}100%25 checked`);
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
  });

  it('annotation message preserves reason carriage return safely', () => {
    const reason = 'a\rb';
    const annotation = format({ reason });
    const parsed = parseAnnotation(annotation);

    expect(parsed.rawMessage).toBe(`missing.md${SEPARATOR}a%0Db`);
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
    expect(annotation).not.toContain('\r');
    expect(parsed.physicalLines).toHaveLength(1);
  });

  it('annotation message preserves reason newline safely', () => {
    const reason = 'a\nb';
    const annotation = format({ reason });
    const parsed = parseAnnotation(annotation);

    expect(parsed.rawMessage).toBe(`missing.md${SEPARATOR}a%0Ab`);
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
    expect(annotation).not.toContain('\n');
    expect(parsed.physicalLines).toHaveLength(1);
  });

  it('annotation message preserves reason comma', () => {
    const reason = 'a,b';
    const parsed = parseAnnotation(format({ reason }));

    expect(parsed.rawMessage).toBe(`missing.md${SEPARATOR}a,b`);
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
  });

  it('annotation message preserves reason colon', () => {
    const reason = 'a:b';
    const parsed = parseAnnotation(format({ reason }));

    expect(parsed.rawMessage).toBe(`missing.md${SEPARATOR}a:b`);
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
  });

  it('annotation message preserves reason Unicode', () => {
    const reason = '理由がありません';
    const parsed = parseAnnotation(format({ reason }));

    expect(parsed.rawMessage).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
  });

  it('annotation message preserves reason workflow-command-like text', () => {
    const reason = '::error file=injected.md,line=1::pwned ::warning::notice';
    const parsed = parseAnnotation(format({ reason }));

    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
  });

  it('annotation message preserves a literal reason percent escape sequence', () => {
    const reason = 'literal %0D sequence';
    const parsed = parseAnnotation(format({ reason }));

    expect(parsed.rawMessage).toBe(
      `missing.md${SEPARATOR}literal %250D sequence`,
    );
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
  });

  it('reason cannot inject another workflow command', () => {
    const reason = 'boom\n::warning file=injected.md,line=1::pwned';
    const annotation = format({ reason });
    const parsed = parseAnnotation(annotation);

    expect(annotation).not.toMatch(/[\r\n]/);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
    expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
  });

  it('decoded annotation message retains the bounded reason', () => {
    const reason = '\n'.repeat(ANNOTATION_LIMITS.reason + 100);
    const parsed = parseAnnotation(format({ reason }));
    const prefix = `${BASE_FINDING.target}${SEPARATOR}`;
    const reasonPart = parsed.message.slice(prefix.length);

    expect(parsed.message.startsWith(prefix)).toBe(true);
    expect(reasonPart.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(reason.startsWith(reasonPart.slice(0, -TRUNCATION_MARKER.length))).toBe(true);
    expect([...parsed.rawMessage].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.message);
  });
});

describe('M11 escaping correctness', () => {
  it('property escaping applies percent before carriage return', () => {
    expect(format({ file: '\r%' })).toBe(
      '::error file=%0D%25,line=14::missing.md — target does not exist',
    );
  });

  it('property escaping applies percent before newline', () => {
    expect(format({ file: '\n%' })).toBe(
      '::error file=%0A%25,line=14::missing.md — target does not exist',
    );
  });

  it('property escaping applies percent before colon', () => {
    expect(format({ file: ':%' })).toBe(
      '::error file=%3A%25,line=14::missing.md — target does not exist',
    );
  });

  it('property escaping applies percent before comma', () => {
    expect(format({ file: ',%' })).toBe(
      '::error file=%2C%25,line=14::missing.md — target does not exist',
    );
  });

  it('message escaping applies percent before carriage return', () => {
    expect(format({ target: '\r%' })).toBe(
      '::error file=docs/guide.md,line=14::%0D%25 — target does not exist',
    );
  });

  it('message escaping applies percent before newline', () => {
    expect(format({ target: '\n%' })).toBe(
      '::error file=docs/guide.md,line=14::%0A%25 — target does not exist',
    );
  });

  it('formatter does not double-encode generated escapes', () => {
    const annotation = format({ file: '%:', target: '%\r\n:' });
    const parsed = parseAnnotation(annotation);

    expect(annotation).toBe(
      '::error file=%25%3A,line=14::%25%0D%0A: — target does not exist',
    );
    expect(parsed.file).toBe('%:');
    expect(parsed.message).toBe(`%\r\n:${SEPARATOR}${BASE_FINDING.reason}`);
  });

  it('message does not property-escape ordinary comma or colon', () => {
    const parsed = parseAnnotation(format({ target: 'a,b:c', reason: 'd,e:f' }));

    expect(parsed.rawMessage).toBe('a,b:c — d,e:f');
    expect(parsed.message).toBe('a,b:c — d,e:f');
    expect(parsed.rawMessage).not.toContain('%2C');
    expect(parsed.rawMessage).not.toContain('%3A');
  });

  it('escaped annotation contains no literal carriage return', () => {
    const annotation = format({ file: 'a\rb', target: 'c\rd', reason: 'e\rf' });

    expect(annotation).not.toContain('\r');
    expect(parseAnnotation(annotation).physicalLines).toHaveLength(1);
  });

  it('escaped annotation contains no literal newline', () => {
    const annotation = format({ file: 'a\nb', target: 'c\nd', reason: 'e\nf' });

    expect(annotation).not.toContain('\n');
    expect(parseAnnotation(annotation).physicalLines).toHaveLength(1);
  });

  it('one special-valued finding remains one annotation', () => {
    const finding: BrokenLinkResult = {
      file: 'docs/a,%:\r\n.md',
      line: 7,
      target: 'x,y:z\r\n::error file=injected.md,line=1::pwned',
      reason: 'r%,\r\n::warning::notice',
    };

    const annotations = formatAnnotations([finding]);
    const parsed = parseAnnotation(annotations[0] ?? '');

    expect(annotations).toHaveLength(1);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
    expect(parsed.file).toBe(finding.file);
    expect(parsed.line).toBe(finding.line);
    expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
  });

  it('several special-valued findings remain one annotation each', () => {
    const findings: readonly BrokenLinkResult[] = [
      { file: 'one,%.md', line: 2, target: 'a\r\nb', reason: 'r%' },
      { file: 'two:%.md', line: 3, target: 'c,d', reason: 's:e' },
      { file: 'three.md', line: 4, target: '::error', reason: '::warning' },
    ];

    const annotations = formatAnnotations(findings);

    expect(annotations).toHaveLength(findings.length);
    for (const [index, annotation] of annotations.entries()) {
      const finding = findings[index];
      if (finding === undefined) {
        throw new Error(`missing finding at index ${index}`);
      }
      const parsed = parseAnnotation(annotation);
      expect(parsed.physicalLines).toHaveLength(1);
      expect(parsed.commandStartCount).toBe(1);
      expect(parsed.file).toBe(finding.file);
      expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
    }
  });

  it('special-valued findings preserve result order', () => {
    const findings: readonly BrokenLinkResult[] = [
      { file: 'first,% file.md', line: 2, target: 'a,b:c', reason: 'r%' },
      { file: 'second.md', line: 3, target: 'd\r\ne', reason: 's' },
      { file: 'third.md', line: 4, target: 'f', reason: 't\n' },
    ];

    expect(formatAnnotations(findings)).toEqual([
      '::error file=first%2C%25 file.md,line=2::a,b:c — r%25',
      '::error file=second.md,line=3::d%0D%0Ae — s',
      '::error file=third.md,line=4::f — t%0A',
    ]);
  });
});

describe('M11 special-value matrix', () => {
  const FILE_CASES: Array<[string, string]> = [
    ['percent', 'docs/100%.md'],
    ['comma', 'docs/a,b.md'],
    ['colon', 'docs/a:b.md'],
    ['carriage return', 'docs/a\rb.md'],
    ['newline', 'docs/a\nb.md'],
    ['Unicode', 'docs/日本語.md'],
    ['literal percent escape', 'docs/literal%0A.md'],
    ['workflow command', 'docs/::error.md'],
  ];

  const TARGET_CASES: Array<[string, string]> = [
    ['percent', 'docs/100%.md'],
    ['carriage return', 'docs/a\rb.md'],
    ['newline', 'docs/a\nb.md'],
    ['comma', 'docs/a,b.md'],
    ['colon', 'docs/a:b.md'],
    ['workflow error text', '::error file=injected.md,line=1::pwned'],
    ['workflow warning text', '::warning::notice'],
    ['literal percent escape', 'docs/literal%0A.md'],
    ['Unicode', 'docs/日本語.md'],
    ['quotes and equals', 'docs/a=b"c.md'],
  ];

  const REASON_CASES: Array<[string, string]> = [
    ['percent', '100% checked'],
    ['carriage return', 'a\rb'],
    ['newline', 'a\nb'],
    ['comma', 'a,b'],
    ['colon', 'a:b'],
    ['workflow error text', '::error file=injected.md,line=1::pwned'],
    ['workflow warning text', '::warning::notice'],
    ['literal percent escape', 'literal %0D sequence'],
    ['Unicode', '理由がありません'],
    ['quotes and equals', 'a=b"c'],
  ];

  it.each(FILE_CASES)('special file value %s survives annotation parsing', (_, file) => {
    const annotation = format({ file });
    const parsed = parseAnnotation(annotation);

    expect(annotation).not.toMatch(/[\r\n]/);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
    expect(decodePropertyValue(parsed.rawFile)).toBe(file);
    expect(parsed.file).toBe(file);
  });

  it.each(TARGET_CASES)(
    'special target value %s survives annotation parsing',
    (_, target) => {
      const parsed = parseAnnotation(format({ target }));

      expect(parsed.physicalLines).toHaveLength(1);
      expect(parsed.commandStartCount).toBe(1);
      expect(decodeMessageData(parsed.rawMessage)).toBe(
        `${target}${SEPARATOR}${BASE_FINDING.reason}`,
      );
      expect(parsed.message).toBe(`${target}${SEPARATOR}${BASE_FINDING.reason}`);
    },
  );

  it.each(REASON_CASES)(
    'special reason value %s survives annotation parsing',
    (_, reason) => {
      const parsed = parseAnnotation(format({ reason }));

      expect(parsed.physicalLines).toHaveLength(1);
      expect(parsed.commandStartCount).toBe(1);
      expect(decodeMessageData(parsed.rawMessage)).toBe(
        `${BASE_FINDING.target}${SEPARATOR}${reason}`,
      );
      expect(parsed.message).toBe(`${BASE_FINDING.target}${SEPARATOR}${reason}`);
    },
  );

  it('combined special values remain one annotation', () => {
    const finding: BrokenLinkResult = {
      file: 'docs/%,\r.md',
      line: 7,
      target: 'a%b,c:d\n::error x',
      reason: 'r%,:\r\n::warning y',
    };

    const annotations = formatAnnotations([finding]);
    const parsed = parseAnnotation(annotations[0] ?? '');

    expect(annotations).toHaveLength(1);
    expect(parsed.physicalLines).toHaveLength(1);
    expect(parsed.commandStartCount).toBe(1);
    expect(parsed.file).toBe(finding.file);
    expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
  });
});

describe('M11 bounds and truncation', () => {
  it('special values below annotation limits round trip', () => {
    const file = 'docs/%/,\r\n.md';
    const target = '😀%\r\n';
    const reason = 'r%,:\r\n';
    const parsed = parseAnnotation(format({ file, target, reason }));

    expect(file.length).toBeLessThan(ANNOTATION_LIMITS.file);
    expect(parsed.file).toBe(file);
    expect(parsed.message).toBe(`${target}${SEPARATOR}${reason}`);
    expect(parsed.file.endsWith(TRUNCATION_MARKER)).toBe(false);
    expect(parsed.message.endsWith(TRUNCATION_MARKER)).toBe(false);
  });

  it('special values at annotation limits remain safe', () => {
    const file = `${'%'.repeat(1_365)}a`;
    const target = `${'\n'.repeat(2_730)}ab`;
    const reason = `${'\n'.repeat(2_729)}ab`;
    const parsed = parseAnnotation(format({ file, target, reason }));

    expect([...parsed.rawFile]).toHaveLength(ANNOTATION_LIMITS.file);
    expect(parsed.rawFile).toBe(`${'%25'.repeat(1_365)}a`);
    expect(parsed.file).toBe(file);
    expect([...parsed.rawMessage]).toHaveLength(ANNOTATION_LIMITS.message);
    expect(parsed.rawMessage).toBe(
      `${'%0A'.repeat(2_730)}ab${SEPARATOR}${'%0A'.repeat(2_729)}ab`,
    );
    expect(parsed.message).toBe(`${target}${SEPARATOR}${reason}`);
    expect(parsed.file.endsWith(TRUNCATION_MARKER)).toBe(false);
    expect(parsed.message.endsWith(TRUNCATION_MARKER)).toBe(false);
  });

  it('special values above annotation limits are marked and bounded', () => {
    const file = '%'.repeat(5_000);
    const target = '\n'.repeat(3_000);
    const reason = '\r'.repeat(4_001);
    const parsed = parseAnnotation(format({ file, target, reason }));
    const [rawTargetPart = '', rawReasonPart = ''] =
      parsed.rawMessage.split(SEPARATOR);

    expect([...parsed.rawFile].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.file);
    expect(parsed.rawFile).toBe(`${'%25'.repeat(1_365)}${TRUNCATION_MARKER}`);
    expect(parsed.file).toBe(`${'%'.repeat(1_365)}${TRUNCATION_MARKER}`);

    // One-over-boundary rendering is deterministic.
    expect(format({ file, target, reason })).toBe(parsed.annotation);

    expect(rawTargetPart).toBe(`${'%0A'.repeat(2_730)}${TRUNCATION_MARKER}`);
    expect(rawReasonPart).toBe(`${'%0D'.repeat(2_729)}${TRUNCATION_MARKER}`);
    expect([...parsed.rawMessage].length).toBeLessThanOrEqual(
      ANNOTATION_LIMITS.message,
    );

    expect(parsed.message).toBe(
      `${'\n'.repeat(2_730)}${TRUNCATION_MARKER}${SEPARATOR}` +
        `${'\r'.repeat(2_729)}${TRUNCATION_MARKER}`,
    );
    expect(file.startsWith(parsed.file.slice(0, -TRUNCATION_MARKER.length))).toBe(
      true,
    );
    expect(
      target.startsWith(
        parsed.message
          .slice(0, parsed.message.indexOf(SEPARATOR))
          .slice(0, -TRUNCATION_MARKER.length),
      ),
    ).toBe(true);
  });

  it('escaping expansion remains within the documented bound', () => {
    const finding: BrokenLinkResult = {
      file: '%'.repeat(ANNOTATION_LIMITS.file * 2),
      line: 1,
      target: '\n'.repeat(ANNOTATION_LIMITS.target),
      reason: ':,'.repeat(ANNOTATION_LIMITS.reason),
    };
    const parsed = parseAnnotation(formatAnnotation(finding));

    expect([...parsed.rawFile].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.file);
    expect([...parsed.rawMessage].length).toBeLessThanOrEqual(
      ANNOTATION_LIMITS.message,
    );
    expect([...parsed.file].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.file);
    expect([...parsed.message].length).toBeLessThanOrEqual(
      ANNOTATION_LIMITS.message,
    );
  });

  it('truncation never cuts a workflow escape', () => {
    const file = '%'.repeat(ANNOTATION_LIMITS.file + 10);
    const target = '\n'.repeat(ANNOTATION_LIMITS.target + 10);
    const parsed = parseAnnotation(format({ file, target }));
    const [rawTargetPart = ''] = parsed.rawMessage.split(SEPARATOR);

    expect(parsed.rawFile).toMatch(/^(?:%25)+…$/);
    expect(rawTargetPart).toMatch(/^(?:%0A)+…$/);
    // The strict decoder itself rejects a partially cut escape sequence.
    expect(parsed.file).toBe(`${'%'.repeat(1_365)}${TRUNCATION_MARKER}`);
  });

  it('truncation never splits a surrogate pair', () => {
    const emoji = '😀';
    const atLimit = parseAnnotation(
      format({ file: emoji.repeat(ANNOTATION_LIMITS.file) }),
    );
    const aboveLimit = parseAnnotation(
      format({ file: emoji.repeat(ANNOTATION_LIMITS.file + 1) }),
    );

    expect(atLimit.file).toBe(emoji.repeat(ANNOTATION_LIMITS.file));
    expect(aboveLimit.file).toBe(
      `${emoji.repeat(ANNOTATION_LIMITS.file - 1)}${TRUNCATION_MARKER}`,
    );
    expect(aboveLimit.annotation).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(aboveLimit.annotation).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('truncation marker survives annotation decoding', () => {
    const parsed = parseAnnotation(
      format({
        file: 'f'.repeat(ANNOTATION_LIMITS.file + 5),
        target: 't'.repeat(ANNOTATION_LIMITS.target + 5),
        reason: 'r'.repeat(ANNOTATION_LIMITS.reason + 10),
      }),
    );
    const [targetPart = '', reasonPart = ''] = parsed.message.split(SEPARATOR);

    expect(parsed.file.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(targetPart.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(reasonPart.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(parsed.rawMessage).toContain(TRUNCATION_MARKER);
  });

  it('annotation truncation does not mutate the structured finding', () => {
    const finding: BrokenLinkResult = Object.freeze({
      file: 'f'.repeat(ANNOTATION_LIMITS.file + 10),
      line: 5,
      target: 't'.repeat(ANNOTATION_LIMITS.target + 10),
      reason: 'r'.repeat(ANNOTATION_LIMITS.reason + 10),
    });
    const before = JSON.stringify(finding);

    formatAnnotation(finding);

    expect(JSON.stringify(finding)).toBe(before);
    expect(finding.line).toBe(5);
    expect(finding.file).toHaveLength(ANNOTATION_LIMITS.file + 10);
    expect(finding.target).toHaveLength(ANNOTATION_LIMITS.target + 10);
    expect(finding.reason).toHaveLength(ANNOTATION_LIMITS.reason + 10);
  });

  it('annotation truncation does not change the CLI diagnostic', () => {
    const diagnostic: Diagnostic = {
      file: 'f'.repeat(ANNOTATION_LIMITS.file + 10),
      line: 5,
      column: 1,
      kind: 'link',
      target: 't'.repeat(ANNOTATION_LIMITS.target + 10),
      reason: 'r'.repeat(ANNOTATION_LIMITS.reason + 10),
    };
    const text = formatDiagnostic(diagnostic);

    expect(text).toBe(
      `${diagnostic.file}:${diagnostic.line}: ${diagnostic.target}${SEPARATOR}${diagnostic.reason}`,
    );
    expect(text).not.toContain(TRUNCATION_MARKER);
    expect(text).not.toContain('%25');
    expect(text).not.toContain('%0A');
    expect(text).not.toContain('%0D');
  });
});

describe('M11 checker integration', () => {
  it('checker-produced file target and reason feed annotation formatting unchanged', async () => {
    const result = await captureRun([M11_SPECIAL_VALUES_FIXTURE]);
    const findings = fixtureRelativeFindings(
      result.diagnostics,
      M11_SPECIAL_VALUES_FIXTURE,
    );
    const annotations = formatAnnotations(findings);

    expect(result.exitCode).toBe(1);
    expect(findings).toEqual(M11_SPECIAL_VALUES_FINDINGS);
    expect(annotations).toHaveLength(M11_SPECIAL_VALUES_FINDINGS.length);
    for (const [index, finding] of findings.entries()) {
      const parsed = parseAnnotation(annotations[index] ?? '');
      expect(parsed.file).toBe(finding.file);
      expect(parsed.line).toBe(finding.line);
      expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
    }
  });

  it('portable special filename produces one annotation', async () => {
    const findings = await m11Findings();

    for (const file of ['100%.md', 'comma,file.md']) {
      const finding = findingFor(findings, (candidate) => candidate.file === file, file);
      const annotations = formatAnnotations([finding]);
      const parsed = parseAnnotation(annotations[0] ?? '');

      expect(annotations).toHaveLength(1);
      expect(parsed.physicalLines).toHaveLength(1);
      expect(parsed.commandStartCount).toBe(1);
      expect(parsed.file).toBe(file);
    }

    const percent = parseAnnotation(
      formatAnnotations([
        findingFor(findings, (candidate) => candidate.file === '100%.md', 'percent file'),
      ])[0] ?? '',
    );
    const comma = parseAnnotation(
      formatAnnotations([
        findingFor(
          findings,
          (candidate) => candidate.file === 'comma,file.md',
          'comma file',
        ),
      ])[0] ?? '',
    );

    expect(percent.rawFile).toBe('100%25.md');
    expect(comma.rawFile).toBe('comma%2Cfile.md');
  });

  it('checker-produced percent target retains its meaning', async () => {
    const findings = await m11Findings();
    const finding = findingFor(
      findings,
      (candidate) => candidate.target === 'docs/100%.md',
      'percent target',
    );
    const parsed = parseAnnotation(formatAnnotation(finding));

    expect(parsed.rawMessage).toBe(
      `docs/100%25.md${SEPARATOR}target does not exist`,
    );
    expect(parsed.message).toBe(
      `docs/100%.md${SEPARATOR}target does not exist`,
    );
  });

  it('checker-produced comma target retains its meaning', async () => {
    const findings = await m11Findings();
    const finding = findingFor(
      findings,
      (candidate) => candidate.target === 'docs/a,b.md',
      'comma target',
    );
    const parsed = parseAnnotation(formatAnnotation(finding));

    expect(parsed.rawMessage).toBe(`docs/a,b.md${SEPARATOR}target does not exist`);
    expect(parsed.message).toBe(`docs/a,b.md${SEPARATOR}target does not exist`);
    expect(parsed.rawMessage).not.toContain('%2C');
  });

  it('checker-produced colon target retains its meaning', async () => {
    const findings = await m11Findings();
    const finding = findingFor(
      findings,
      (candidate) => candidate.target === 'docs/a:b.md',
      'colon target',
    );
    const parsed = parseAnnotation(formatAnnotation(finding));

    expect(parsed.rawMessage).toBe(`docs/a:b.md${SEPARATOR}target does not exist`);
    expect(parsed.message).toBe(`docs/a:b.md${SEPARATOR}target does not exist`);
    expect(parsed.rawMessage).not.toContain('%3A');
  });

  it('checker result order remains annotation order', async () => {
    const findings = await m11Findings();
    const annotations = formatAnnotations(findings);

    expect(annotations).toEqual(M11_EXPECTED_ANNOTATIONS);
    expect(annotations).toHaveLength(findings.length);
    for (const [index, finding] of findings.entries()) {
      const parsed = parseAnnotation(annotations[index] ?? '');
      expect(parsed.file).toBe(finding.file);
      expect(parsed.line).toBe(finding.line);
      expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
    }
  });

  it('formatter consumes the M9 result without parsing text or JSON', async () => {
    const result = await captureRun([M11_SPECIAL_VALUES_FIXTURE]);
    const rawFindings = result.diagnostics;
    const annotations = formatAnnotations(rawFindings);

    expect(result.exitCode).toBe(1);
    expect(annotations).toHaveLength(rawFindings.length);
    for (const [index, finding] of rawFindings.entries()) {
      const parsed = parseAnnotation(annotations[index] ?? '');
      expect(parsed.file).toBe(finding.file);
      expect(parsed.line).toBe(finding.line);
      expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
    }

    const formatterSource = readFileSync(join(REPO_ROOT, 'src', 'annotation.ts'), 'utf8');
    expect(formatterSource).not.toMatch(/JSON\.parse|readFileSync|process\.stdout|process\.stderr/);
  });
});

describe('M11 human-readable compatibility', () => {
  it('matching percent diagnostic is byte-for-byte unchanged', async () => {
    const result = await runM11Cli();

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(M11_EXPECTED_TEXT);
    expect(result.stdout).toContain(
      '100%.md:3: missing-target.md — target does not exist\n',
    );
    expect(result.stdout).toContain(
      'README.md:3: docs/100%.md — target does not exist\n',
    );
  });

  it('matching comma diagnostic is byte-for-byte unchanged', async () => {
    const result = await runM11Cli();

    expect(result.stdout).toBe(M11_EXPECTED_TEXT);
    expect(result.stdout).toContain(
      'README.md:4: docs/a,b.md — target does not exist\n',
    );
    expect(result.stdout).toContain(
      'comma,file.md:3: missing-target.md — target does not exist\n',
    );
  });

  it('matching colon diagnostic is byte-for-byte unchanged', async () => {
    const result = await runM11Cli();

    expect(result.stdout).toBe(M11_EXPECTED_TEXT);
    expect(result.stdout).toContain(
      'README.md:5: docs/a:b.md — target does not exist\n',
    );
  });

  it('matching Unicode diagnostic is byte-for-byte unchanged', async () => {
    const result = await runM11Cli();

    expect(result.stdout).toBe(M11_EXPECTED_TEXT);
    expect(result.stdout).toContain(
      'README.md:8: docs/日本語.md — target does not exist\n',
    );
  });

  it('ordinary diagnostic contains no annotation escaping', async () => {
    const result = await runM11Cli();

    expect(result.stdout).not.toContain('%25');
    expect(result.stdout).not.toContain('%2C');
    expect(result.stdout).not.toContain('%3A');
    expect(result.stdout).not.toContain('%0D');
    // The only %0A in the text is the fixture's literal target value.
    expect(result.stdout.split('%0A')).toHaveLength(2);
    for (const finding of M11_SPECIAL_VALUES_FINDINGS) {
      expect(result.stdout).toContain(
        `${finding.file}:${finding.line}: ${finding.target}${SEPARATOR}${finding.reason}\n`,
      );
    }
  });

  it('ordinary diagnostic emits no workflow command', async () => {
    const result = await runM11Cli();
    const lines = result.stdout.split('\n');

    expect(result.stdout.startsWith('100%.md:3:')).toBe(true);
    expect(lines.some((line) => line.startsWith('::'))).toBe(false);
  });

  it('stdout and stderr routing remain unchanged', async () => {
    const broken = await runM11Cli();
    const clean = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const usage = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    expect(broken.stderr).toBe('');
    expect(broken.stdout).not.toBe('');
    expect(clean.stderr).toBe('');
    expect(clean.stdout).not.toBe('');
    expect(usage.stdout).toBe('');
    expect(usage.stderr).not.toBe('');
  });

  it('exit codes 0 1 and 2 remain unchanged', async () => {
    expect((await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE })).status).toBe(0);
    expect((await runM11Cli()).status).toBe(1);
    expect((await runCli([], { cwd: M9_CLEAN_FIXTURE })).status).toBe(2);
  });
});

describe('M11 JSON compatibility', () => {
  const REPORT_KEYS = ['diagnostics', 'exitCode', 'external', 'ok', 'summary', 'version'];
  const SUMMARY_KEYS = ['broken', 'externalSkipped', 'filesChecked'];
  const DIAGNOSTIC_KEYS = ['column', 'file', 'kind', 'line', 'reason', 'target'];
  const EXTERNAL_KEYS = [
    'brokenOccurrences',
    'cache',
    'distinctChecked',
    'enabled',
    'failed',
    'occurrences',
    'results',
    'skipped',
    'succeeded',
  ];
  const CACHE_KEYS = ['enabled', 'hits', 'misses', 'stale'];

  it('JSON retains original special-valued file', async () => {
    const { result, document } = await runM11Json();
    const files = document.diagnostics.map((diagnostic) => diagnostic.file);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(files).toEqual(M11_SPECIAL_VALUES_FINDINGS.map((finding) => finding.file));
    expect(files).toContain('100%.md');
    expect(files).toContain('comma,file.md');
    expect(files.join('\n')).not.toContain('%25');
    expect(files.join('\n')).not.toContain('%2C');
  });

  it('JSON retains original special-valued target', async () => {
    const { document } = await runM11Json();
    const targets = document.diagnostics.map((diagnostic) => diagnostic.target);

    expect(targets).toEqual(
      M11_SPECIAL_VALUES_FINDINGS.map((finding) => finding.target),
    );
    expect(targets).toContain('docs/100%.md');
    expect(targets).toContain('docs/a,b.md');
    expect(targets).toContain('docs/a:b.md');
    expect(targets).toContain('docs/literal%0A.md');
    expect(targets).toContain('docs/::error.md');
    expect(targets).toContain('docs/::warning.md');
  });

  it('JSON retains original special-valued reason', async () => {
    const { document } = await runM11Json();
    const reasons = document.diagnostics.map((diagnostic) => diagnostic.reason);

    expect(reasons).toEqual(M11_SPECIAL_VALUES_FINDINGS.map((finding) => finding.reason));
    expect(reasons).toEqual(new Array(M11_SPECIAL_VALUES_FINDINGS.length).fill('target does not exist'));
  });

  it('JSON does not contain workflow escapes in place of values', async () => {
    const { result, document } = await runM11Json();

    for (const diagnostic of document.diagnostics) {
      for (const value of [diagnostic.file, diagnostic.target, diagnostic.reason]) {
        expect(value).not.toContain('%25');
        expect(value).not.toContain('%0D');
        expect(value).not.toContain('%2C');
        expect(value).not.toContain('%3A');
      }
      expect(
        diagnostic.target === 'docs/literal%0A.md' ||
          !diagnostic.target.includes('%0A'),
      ).toBe(true);
    }
    expect(result.stdout).not.toContain('100%25.md');
    expect(result.stdout).not.toContain('comma%2Cfile.md');
    expect(result.stdout).not.toContain('%2525');
    expect(result.stdout).not.toContain('%250A');
    // Ordinary JSON escaping, not workflow escaping, protects the quote.
    expect(result.stdout).toContain('docs/a=b\\"c.md');
  });

  it('M11 removes no JSON field', async () => {
    const { document } = await runM11Json();

    expect(Object.keys(document)).toEqual(expect.arrayContaining(REPORT_KEYS));
    expect(Object.keys(document.summary)).toEqual(expect.arrayContaining(SUMMARY_KEYS));
    expect(Object.keys(document.external)).toEqual(expect.arrayContaining(EXTERNAL_KEYS));
    expect(Object.keys(document.external.cache)).toEqual(
      expect.arrayContaining(CACHE_KEYS),
    );
    for (const diagnostic of document.diagnostics) {
      expect(Object.keys(diagnostic)).toEqual(expect.arrayContaining(DIAGNOSTIC_KEYS));
    }
  });

  it('M11 renames no JSON field', async () => {
    const { document } = await runM11Json();

    expect(Object.keys(document).sort()).toEqual([...REPORT_KEYS].sort());
    expect(Object.keys(document.summary).sort()).toEqual([...SUMMARY_KEYS].sort());
    expect(Object.keys(document.external).sort()).toEqual([...EXTERNAL_KEYS].sort());
    expect(Object.keys(document.external.cache).sort()).toEqual([...CACHE_KEYS].sort());
    for (const diagnostic of document.diagnostics) {
      expect(Object.keys(diagnostic).sort()).toEqual([...DIAGNOSTIC_KEYS].sort());
    }
  });

  it('M11 adds no JSON field', async () => {
    const { document } = await runM11Json();

    expect(Object.keys(document)).toHaveLength(REPORT_KEYS.length);
    expect(Object.keys(document.summary)).toHaveLength(SUMMARY_KEYS.length);
    expect(Object.keys(document.external)).toHaveLength(EXTERNAL_KEYS.length);
    expect(Object.keys(document.external.cache)).toHaveLength(CACHE_KEYS.length);
    for (const diagnostic of document.diagnostics) {
      expect(Object.keys(diagnostic)).toHaveLength(DIAGNOSTIC_KEYS.length);
    }
  });

  it('JSON diagnostic order remains unchanged', async () => {
    const { document } = await runM11Json();
    const structured = await m11Findings();

    expect(
      document.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    ).toEqual(structured);
    expect(document.diagnostics.map((diagnostic) => diagnostic.target)).toEqual(
      M11_SPECIAL_VALUES_FINDINGS.map((finding) => finding.target),
    );
  });
});

describe('M11 non-wiring and scope', () => {
  it('formatter remains unwired from runAction', async () => {
    const action = await runAction({
      cwd: M11_SPECIAL_VALUES_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(action.status).toBe(1);
    expect(action.stdout.split('\n').some((line) => line.startsWith('::'))).toBe(false);
    expect(readActionArtifactText()).not.toContain('formatAnnotation');
    for (const file of ['action-runner.ts', 'action.ts']) {
      const source = readFileSync(join(REPO_ROOT, 'src', file), 'utf8');
      expect(source).not.toMatch(/formatAnnotation|annotation\.js/);
    }
  });

  it('normal action execution emits no annotation in M11', async () => {
    const action = await runAction({
      cwd: M11_SPECIAL_VALUES_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(action.status).toBe(1);
    expect(action.stderr).toBe('');
    expect(action.stdout).toBe(M11_EXPECTED_TEXT);
  });

  it('normal CLI execution emits no annotation in M11', async () => {
    const result = await runM11Cli();

    expect(result.stdout).toBe(M11_EXPECTED_TEXT);
    expect(result.stdout.split('\n').some((line) => line.startsWith('::'))).toBe(false);
  });

  it('M11 changes no path under github metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('M11 changes no path under project metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('M11 adds no workflow', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/workflows/'))).toEqual([]);
  });
});
