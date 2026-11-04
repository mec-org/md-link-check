import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCommandLine,
  emitAnnotations,
  readActionInputs,
  runAction as runSourceAction,
} from '../src/action-runner.js';
import {
  ANNOTATION_LIMITS,
  formatAnnotations,
  TRUNCATION_MARKER,
} from '../src/annotation.js';
import type { BrokenLinkResult, CliIo, RunResult } from '../src/run.js';
import {
  ACTION_ARTIFACT_PATH,
  REPO_ROOT,
  copyActionRuntime,
  readActionArtifactText,
  readActionMetadata,
  readScopeReport,
  requireMapping,
  requireScalar,
  runAction as runCommittedAction,
  runActionBuild,
  runCli,
  runNode,
} from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import {
  captureRun,
  M9_BROKEN_FINDINGS,
  M9_BROKEN_FIXTURE,
  M9_CLEAN_FIXTURE,
} from './m9-helpers.js';
import {
  M11_SPECIAL_VALUES_FINDINGS,
  M11_SPECIAL_VALUES_FIXTURE,
  parseAnnotation,
} from './m11-helpers.js';
import { startFixtureServer } from './server.js';

const SEPARATOR = ' — ';

/** Frozen CLI-owned broken output for the committed M9 fixture, run from its root. */
const BROKEN_CLI_TEXT = `${[
  ...M9_BROKEN_FINDINGS.map(
    ({ file, line, target, reason }) => `${file}:${line}: ${target}${SEPARATOR}${reason}`,
  ),
  'Checked 2 files: 9 broken targets, 1 external link skipped.',
].join('\n')}\n`;

/** Frozen CLI-owned clean output for the committed M9 fixture, run from its root. */
const CLEAN_CLI_TEXT =
  'Checked 2 files: 0 broken targets, 1 external link skipped.\n';

/** Frozen CLI-owned usage output, written to stderr, with no input paths. */
const USAGE_TEXT = [
  'md-link-check: no input paths',
  '',
  'Usage: md-link-check [--json] [--external] <path...>',
  'Run "md-link-check --help" for usage and exit codes.',
  '',
].join('\n');

/** The formatter's expected output for the frozen M9 broken findings. */
const M9_EXPECTED_ANNOTATIONS = formatAnnotations(M9_BROKEN_FINDINGS);

interface CapturedAction {
  exitCode: RunResult['exitCode'];
  diagnostics: RunResult['diagnostics'];
  stdout: string;
  stderr: string;
}

/**
 * Runs the action wrapper in-process from TypeScript source, capturing its
 * streams exactly as the GitHub runner would observe them. Nothing is parsed
 * back out of the captured text to obtain findings.
 */
async function captureSourceAction(
  environment: NodeJS.ProcessEnv,
): Promise<CapturedAction> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    writeOut: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
  };
  const result = await runSourceAction(environment, io);
  return { exitCode: result.exitCode, diagnostics: result.diagnostics, stdout, stderr };
}

/** Runs the committed action artifact as the GitHub runner would. */
function runArtifactAction(
  cwd: string,
  inputs: Record<string, string | undefined>,
  options: { artifactPath?: string; fetchLog?: string } = {},
) {
  return runCommittedAction({
    cwd,
    inputs,
    ...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
    ...(options.fetchLog === undefined ? {} : { fetchLog: options.fetchLog }),
  });
}

/**
 * Splits action stdout into the CLI-owned prefix and the trailing annotation
 * lines using the structured finding count, never by parsing CLI text to
 * recover findings. Action output conventionally ends with one newline.
 */
function splitActionOutput(
  stdout: string,
  findingCount: number,
): { cli: string; annotations: string[] } {
  const lines = stdout.split('\n');
  expect(lines.at(-1)).toBe('');
  const body = lines.slice(0, -1);
  const annotations = body.slice(body.length - findingCount);
  const cliLines = body.slice(0, body.length - findingCount);
  return { cli: cliLines.length === 0 ? '' : `${cliLines.join('\n')}\n`, annotations };
}

/** Counts physical annotation lines in a captured stream without parsing them. */
function annotationLineCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.startsWith('::error ')).length;
}

/** Formats findings through the integrated action emission helper. */
function emittedText(findings: readonly BrokenLinkResult[]): string {
  const chunks: string[] = [];
  emitAnnotations(findings, {
    writeOut: (text) => {
      chunks.push(text);
    },
    writeError: () => undefined,
  });
  return chunks.join('');
}

/** Captures the CLI-owned text of an in-process action run. */
function actionCliText(action: CapturedAction): string {
  return splitActionOutput(action.stdout, action.diagnostics.length).cli;
}

/** Captures the emitted annotations of an in-process action run. */
function actionAnnotations(action: CapturedAction): string[] {
  return splitActionOutput(action.stdout, action.diagnostics.length).annotations;
}

/** Parses every annotation of an in-process action run. */
function actionParsedAnnotations(action: CapturedAction) {
  return actionAnnotations(action).map((annotation) => parseAnnotation(annotation));
}

function requireFinding(
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

/** A one-finding broken fixture whose file and source line are known. */
function brokenSourceFixture(): { root: string; file: string } {
  const root = makeTempRoot();
  writeFiles(root, { 'README.md': '# Broken\n\n[missing](missing.md)\n' });
  return { root, file: join(root, 'README.md') };
}

describe('M12 source action annotation integration', () => {
  it('broken action run emits one annotation for one finding', async () => {
    const { file } = brokenSourceFixture();
    const action = await captureSourceAction({ INPUT_PATHS: file });

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).toHaveLength(1);
    expect(annotationLineCount(action.stdout)).toBe(1);
    expect(actionAnnotations(action)).toHaveLength(1);
    expect(actionAnnotations(action)[0]).toMatch(/^::error file=/);
  });

  it('broken action run preserves the unchanged CLI diagnostic', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);
    const { cli: cliText } = splitActionOutput(
      action.stdout,
      action.diagnostics.length,
    );

    expect(action.exitCode).toBe(1);
    expect(cliText).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
  });

  it('annotation contains the broken Markdown file', async () => {
    const { root, file } = brokenSourceFixture();
    const action = await captureSourceAction({ INPUT_PATHS: file });
    const [parsed] = actionParsedAnnotations(action);

    expect(parsed).toBeDefined();
    expect(parsed?.file).toBe(file);
    expect(relative(root, parsed?.file ?? '')).toBe('README.md');
  });

  it('annotation contains the one-based source line', async () => {
    const { file } = brokenSourceFixture();
    const action = await captureSourceAction({ INPUT_PATHS: file });
    const [parsed] = actionParsedAnnotations(action);

    expect(action.diagnostics[0]?.line).toBe(3);
    expect(parsed?.line).toBe(3);
    expect(actionAnnotations(action)[0]).toContain(',line=3::');
  });

  it('annotation message contains target and reason', async () => {
    const { file } = brokenSourceFixture();
    const action = await captureSourceAction({ INPUT_PATHS: file });
    const [parsed] = actionParsedAnnotations(action);

    expect(parsed?.message).toBe(`missing.md${SEPARATOR}target does not exist`);
    expect(actionAnnotations(action)[0]).toContain(
      `::missing.md${SEPARATOR}target does not exist`,
    );
  });

  it('annotation is emitted after unchanged CLI output', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);
    const { cli: cliText } = splitActionOutput(
      action.stdout,
      action.diagnostics.length,
    );
    const summaryIndex = action.stdout.indexOf(
      'Checked 2 files: 9 broken targets, 1 external link skipped.',
    );
    const firstAnnotationIndex = action.stdout.indexOf('::error ');

    expect(cliText).toBe(cli.stdout);
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(firstAnnotationIndex).toBeGreaterThan(summaryIndex);
    expect(action.stdout.endsWith('\n')).toBe(true);
  });

  it('annotation is a separate physical output line', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const annotations = actionAnnotations(action);

    expect(annotations).toHaveLength(action.diagnostics.length);
    for (const annotation of annotations) {
      expect(annotation).not.toContain('\n');
      expect(annotation).not.toContain('\r');
      expect(annotation.split('::error ')).toHaveLength(2);
    }
    expect(annotationLineCount(action.stdout)).toBe(action.diagnostics.length);
    for (const line of action.stdout.split('\n')) {
      expect(line.match(/::error /g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it('clean action run emits no annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
    expect(action.stdout).toBe(cli.stdout);
    expect(action.stderr).toBe('');
    expect(action.stdout).not.toContain('::error');
    expect(annotationLineCount(action.stdout)).toBe(0);
  });

  it('usage-error action run emits no annotation', async () => {
    const action = await captureSourceAction({});

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.stdout).toBe('');
    expect(action.stderr).toContain('no input paths');
    expect(`${action.stdout}${action.stderr}`).not.toContain('::error');
    expect(`${action.stdout}${action.stderr}`).not.toMatch(/^::[a-z-]+/m);
  });

  it('annotation count equals structured finding count', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.diagnostics).toHaveLength(M9_BROKEN_FINDINGS.length);
    expect(actionAnnotations(action)).toHaveLength(action.diagnostics.length);
    expect(annotationLineCount(action.stdout)).toBe(action.diagnostics.length);
  });

  it('multiple action findings preserve result order', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const annotations = actionAnnotations(action);

    expect(annotations).toEqual(formatAnnotations(action.diagnostics));
    for (const [index, finding] of action.diagnostics.entries()) {
      const parsed = parseAnnotation(annotations[index] ?? '');
      expect(parsed.file).toBe(finding.file);
      expect(parsed.line).toBe(finding.line);
      expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
    }
  });

  it('duplicate findings remain duplicate annotations', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const duplicate = requireFinding(
      action.diagnostics,
      (finding) =>
        finding.line === 7 && finding.target === 'docs/missing.md',
      'the duplicated line-7 finding',
    );
    const rendered = formatAnnotations([duplicate])[0] ?? '';

    expect(actionAnnotations(action).filter((annotation) => annotation === rendered)).toHaveLength(
      2,
    );
  });

  it('action integration uses structured findings without parsing text or JSON', async () => {
    const written: string[] = [];
    const io: CliIo = {
      writeOut: (text) => {
        written.push(text);
      },
      writeError: (text) => {
        written.push(text);
      },
    };
    const result = await runSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE }, io);
    const emitted = written.filter((chunk) => chunk.startsWith('::error '));

    expect(emitted).toEqual(
      formatAnnotations(result.diagnostics).map((annotation) => `${annotation}\n`),
    );

    const runnerSource = readFileSync(
      join(REPO_ROOT, 'src', 'action-runner.ts'),
      'utf8',
    );
    expect(runnerSource).toContain("import { formatAnnotations } from './annotation.js';");
    expect(runnerSource).toContain('emitAnnotations(result.diagnostics, io)');
    expect(runnerSource).toContain('formatAnnotations(findings)');
    expect(runnerSource).not.toMatch(/JSON\.parse|readFileSync|readdirSync|child_process/);
  });
});

describe('M12 action finding coverage', () => {
  it('action annotates a missing local file', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const parsed = actionParsedAnnotations(action).find(
      (annotation) => annotation.message === `docs/missing.md${SEPARATOR}target does not exist`,
    );

    expect(parsed).toBeDefined();
    expect(parsed?.file).toMatch(/README\.md$/);
    expect(parsed?.line).toBe(3);
  });

  it('action annotates a missing local image', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const parsed = actionParsedAnnotations(action).find(
      (annotation) =>
        annotation.message === `images/missing.png${SEPARATOR}target does not exist`,
    );

    expect(parsed).toBeDefined();
    expect(parsed?.file).toMatch(/README\.md$/);
    expect(parsed?.line).toBe(4);
  });

  it('action annotates a missing anchor', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const parsed = actionParsedAnnotations(action).find(
      (annotation) =>
        annotation.message === `#missing-anchor${SEPARATOR}anchor does not exist`,
    );

    expect(parsed).toBeDefined();
    expect(parsed?.file).toMatch(/README\.md$/);
    expect(parsed?.line).toBe(4);
  });

  it('action annotates a broken raw HTML target', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# HTML',
        '',
        '<a href="missing-html.md">missing</a>',
        '',
        '<img src="images/missing-html.png">',
        '',
        '<a href="#missing-html-anchor">anchor</a>',
        '',
      ].join('\n'),
    });
    const action = await captureSourceAction({
      INPUT_PATHS: join(root, 'README.md'),
    });
    const [first, second, third] = actionParsedAnnotations(action);

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).toHaveLength(3);
    expect(first?.file).toBe(join(root, 'README.md'));
    expect(first?.line).toBe(3);
    expect(first?.message).toBe(`missing-html.md${SEPARATOR}target does not exist`);
    expect(second?.message).toBe(
      `images/missing-html.png${SEPARATOR}target does not exist`,
    );
    expect(third?.message).toBe(
      `#missing-html-anchor${SEPARATOR}anchor does not exist`,
    );
  });

  it('action annotates an enabled external failure', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeFiles(root, { 'README.md': `# Consumer\n\n[external](${target})\n` });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
      });
      const [parsed] = actionParsedAnnotations(action);

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toHaveLength(1);
      expect(parsed?.file).toBe(join(root, 'README.md'));
      expect(parsed?.line).toBe(3);
      expect(parsed?.message).toBe(`${target}${SEPARATOR}external HTTP 404`);
      expect(action.stdout).toContain(`${target}${SEPARATOR}external HTTP 404`);
      expect(server.requests.map((request) => request.path)).toEqual(['/not-found']);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default skipped external target emits no annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.exitCode).toBe(1);
    expect(actionCliText(action)).toContain('1 external link skipped');
    for (const annotation of actionParsedAnnotations(action)) {
      expect(annotation.message).not.toMatch(/https?:/);
    }
    expect(action.diagnostics.every((finding) => !finding.target.startsWith('http'))).toBe(
      true,
    );
  });

  it('summary lines emit no annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const { cli } = splitActionOutput(action.stdout, action.diagnostics.length);

    expect(cli.trimEnd().split('\n').at(-1)).toBe(
      'Checked 2 files: 9 broken targets, 1 external link skipped.',
    );
    for (const annotation of actionAnnotations(action)) {
      expect(annotation).not.toContain('Checked ');
      expect(annotation).not.toContain('skipped');
    }
  });

  it('usage diagnostics emit no annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: 'does-not-exist' });

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.stdout).toBe('');
    expect(action.stderr).toContain('cannot access input path "does-not-exist"');
    expect(`${action.stdout}${action.stderr}`).not.toContain('::error');
  });
});

describe('M12 action output preservation', () => {
  it('action diagnostic bytes remain unchanged before annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(actionCliText(action)).toBe(cli.stdout);
    expect(cli.stdout.trimEnd().split('\n')).toHaveLength(
      M9_BROKEN_FINDINGS.length + 1,
    );
  });

  it('action clean CLI output remains unchanged', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(action.stdout).toBe(cli.stdout);
    expect(cli.stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  it('action usage output remains unchanged', async () => {
    const action = await captureSourceAction({});
    const cli = await captureRun([]);

    expect(action.stdout).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
    expect(action.exitCode).toBe(cli.exitCode);
  });

  it('action summary remains unchanged', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);
    const summary = actionCliText(action).trimEnd().split('\n').at(-1);

    expect(summary).toBe(cli.stdout.trimEnd().split('\n').at(-1));
    expect(summary).toBe('Checked 2 files: 9 broken targets, 1 external link skipped.');
    expect(action.stdout.indexOf('::error ')).toBeGreaterThan(
      action.stdout.indexOf(summary ?? ''),
    );
  });

  it('action stdout and stderr routing remain unchanged', async () => {
    const clean = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const broken = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const usage = await captureSourceAction({});

    expect(clean.stderr).toBe('');
    expect(clean.stdout).not.toBe('');
    expect(broken.stderr).toBe('');
    expect(broken.stdout).not.toBe('');
    expect(usage.stdout).toBe('');
    expect(usage.stderr).not.toBe('');
  });

  it('action CLI newline behavior remains unchanged', async () => {
    const clean = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const broken = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const usage = await captureSourceAction({});

    for (const output of [clean.stdout, broken.stdout, usage.stderr]) {
      expect(output.endsWith('\n')).toBe(true);
      expect(output.endsWith('\n\n')).toBe(false);
      expect(output).not.toContain('\r');
    }
    for (const annotation of actionAnnotations(broken)) {
      expect(annotation.endsWith('\n')).toBe(false);
    }
  });

  it('ordinary action diagnostics contain no workflow escaping', async () => {
    const action = await captureSourceAction({
      INPUT_PATHS: M11_SPECIAL_VALUES_FIXTURE,
    });
    const cli = await captureRun([M11_SPECIAL_VALUES_FIXTURE]);
    const cliText = actionCliText(action);

    expect(cliText).toBe(cli.stdout);
    for (const value of ['docs/100%.md', 'docs/a,b.md', 'docs/a:b.md', 'comma,file.md']) {
      expect(cliText).toContain(value);
    }
    expect(cliText).not.toContain('%25');
    expect(cliText).not.toContain('%2C');
    expect(cliText).not.toContain('%3A');
    expect(cliText).not.toContain('%0D');
    // Only annotations carry the workflow escapes.
    expect(actionAnnotations(action).some((annotation) => annotation.includes('%25'))).toBe(
      true,
    );
    expect(actionAnnotations(action).some((annotation) => annotation.includes('%2C'))).toBe(
      true,
    );
  });

  it('action JSON contract remains unchanged', async () => {
    expect(buildCommandLine({ paths: ['.'], external: false })).toEqual(['--', '.']);
    expect(buildCommandLine({ paths: ['.'], external: true })).toEqual([
      '--external',
      '--',
      '.',
    ]);

    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    expect(action.stdout.trimStart().startsWith('{')).toBe(false);

    const json = await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const document = JSON.parse(json.stdout) as Record<string, unknown>;

    expect(json.status).toBe(1);
    expect(Object.keys(document).sort()).toEqual([
      'diagnostics',
      'exitCode',
      'external',
      'ok',
      'summary',
      'version',
    ]);
    expect((document.diagnostics as unknown[]).length).toBe(M9_BROKEN_FINDINGS.length);
    expect(json.stdout).not.toContain('::error');
  });
});

describe('M12 action safe-value integration', () => {
  it('action annotations reuse the safe formatter', async () => {
    const action = await captureSourceAction({
      INPUT_PATHS: M11_SPECIAL_VALUES_FIXTURE,
    });

    expect(actionAnnotations(action)).toEqual(formatAnnotations(action.diagnostics));
    expect(
      readFileSync(join(REPO_ROOT, 'src', 'annotation.ts'), 'utf8'),
    ).toContain('export function formatAnnotations(');
    expect(
      readFileSync(join(REPO_ROOT, 'src', 'action-runner.ts'), 'utf8'),
    ).toMatch(/formatAnnotations\(/);
  });

  it('special-valued finding remains one action annotation', async () => {
    const action = await captureSourceAction({
      INPUT_PATHS: M11_SPECIAL_VALUES_FIXTURE,
    });
    const parsed = actionParsedAnnotations(action);

    expect(parsed).toHaveLength(M11_SPECIAL_VALUES_FINDINGS.length);
    for (const [index, annotation] of parsed.entries()) {
      const finding = action.diagnostics[index];
      expect(annotation.file).toBe(finding?.file);
      expect(annotation.line).toBe(finding?.line);
      expect(annotation.message).toBe(
        `${finding?.target}${SEPARATOR}${finding?.reason}`,
      );
    }
  });

  it('special-valued CLI diagnostic remains unchanged', async () => {
    const action = await captureSourceAction({
      INPUT_PATHS: M11_SPECIAL_VALUES_FIXTURE,
    });
    const cli = await captureRun([M11_SPECIAL_VALUES_FIXTURE]);
    const cliText = actionCliText(action);

    expect(cliText).toBe(cli.stdout);
    for (const finding of action.diagnostics) {
      expect(cliText).toContain(
        `${finding.file}:${finding.line}: ${finding.target}${SEPARATOR}${finding.reason}\n`,
      );
    }
  });

  it('newline in finding cannot inject a second annotation', () => {
    const finding: BrokenLinkResult = {
      file: 'docs/a\nb.md',
      line: 4,
      target: 'missing\n::error file=injected.md,line=1::pwned',
      reason: 'target\rdoes not exist',
    };
    const output = emittedText([finding]);
    const lines = output.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('');
    expect(lines[0]).not.toContain('\r');
    expect(lines.filter((line) => line.startsWith('::error '))).toHaveLength(1);

    const parsed = parseAnnotation(lines[0] ?? '');
    expect(parsed.file).toBe(finding.file);
    expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
    expect(parsed.rawFile).toContain('%0A');
    expect(parsed.rawMessage).toContain('%0A');
    expect(parsed.rawMessage).toContain('%0D');
  });

  it('comma and colon in file cannot inject annotation properties', () => {
    const finding: BrokenLinkResult = {
      file: 'docs/a,line=99:b.md',
      line: 6,
      target: 'missing.md',
      reason: 'target does not exist',
    };
    const output = emittedText([finding]);
    const parsed = parseAnnotation(output.trimEnd());

    expect(output.split('\n')).toHaveLength(2);
    expect(parsed.rawFile).toBe('docs/a%2Cline=99%3Ab.md');
    expect(parsed.file).toBe(finding.file);
    expect(parsed.line).toBe(6);
  });

  it('workflow-command-like target remains annotation data', () => {
    const finding: BrokenLinkResult = {
      file: 'docs/guide.md',
      line: 8,
      target: '::error file=injected.md,line=1::pwned',
      reason: 'target does not exist',
    };
    const output = emittedText([finding]);
    const parsed = parseAnnotation(output.trimEnd());

    expect(output.split('\n')).toHaveLength(2);
    expect(parsed.message).toBe(`${finding.target}${SEPARATOR}${finding.reason}`);
    expect(parsed.file).toBe(finding.file);
    expect(parsed.line).toBe(8);
  });

  it('annotation bounds remain deterministic through action integration', () => {
    const finding: BrokenLinkResult = {
      file: 'f'.repeat(ANNOTATION_LIMITS.file + 10),
      line: 9,
      target: 't'.repeat(ANNOTATION_LIMITS.target + 10),
      reason: 'r'.repeat(ANNOTATION_LIMITS.reason + 10),
    };

    const first = emittedText([finding]);
    const second = emittedText([finding]);
    expect(first).toBe(second);

    const parsed = parseAnnotation(first.trimEnd());
    expect(first.split('\n')).toHaveLength(2);
    expect([...parsed.rawFile].length).toBeLessThanOrEqual(ANNOTATION_LIMITS.file);
    expect([...parsed.rawMessage].length).toBeLessThanOrEqual(
      ANNOTATION_LIMITS.message,
    );
    expect(parsed.rawFile.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(parsed.file.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(parsed.message.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe('M12 action exit codes', () => {
  it('clean annotated action exits 0', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });

    expect(action.exitCode).toBe(0);
    expect(actionAnnotations(action)).toEqual([]);
  });

  it('broken annotated action exits 1', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.exitCode).toBe(1);
    expect(actionAnnotations(action)).toHaveLength(action.diagnostics.length);
  });

  it('action usage error exits 2', async () => {
    const action = await captureSourceAction({});

    expect(action.exitCode).toBe(2);
    expect(actionAnnotations(action)).toEqual([]);
  });

  it('annotation emission does not change exit code', async () => {
    const clean = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const broken = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const usage = await captureSourceAction({});

    expect(clean.exitCode).toBe((await captureRun([M9_CLEAN_FIXTURE])).exitCode);
    expect(broken.exitCode).toBe((await captureRun([M9_BROKEN_FIXTURE])).exitCode);
    expect(usage.exitCode).toBe((await captureRun([])).exitCode);
  });

  it('multiple annotations still exit 1', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.exitCode).toBe(1);
    expect(actionAnnotations(action).length).toBeGreaterThan(1);
  });

  it('skipped external targets do not change exit 0', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });

    expect(action.exitCode).toBe(0);
    expect(actionCliText(action)).toContain('1 external link skipped');
    expect(actionAnnotations(action)).toEqual([]);
  });

  it('enabled broken external target exits 1 through a finding', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Consumer\n\n[external](${server.urlFor('/not-found')})\n`,
    });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toHaveLength(1);
      expect(actionAnnotations(action)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('M12 annotation emission failure', () => {
  it('annotation write failure follows the internal-error contract', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, INPUT_PATHS: '.' };
    // The runner provides GITHUB_OUTPUT to its steps; a test child must never
    // append to that file.
    delete env.GITHUB_OUTPUT;

    const result = await runNode(join(REPO_ROOT, 'dist', 'action.js'), [], {
      cwd: M9_BROKEN_FIXTURE,
      env,
      requires: [join(REPO_ROOT, 'test', 'action-write-failure.cjs')],
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(2);
    // The CLI had already written its complete output when the annotation write
    // failed; no annotation and no fabricated finding follow.
    expect(result.stdout).toBe(BROKEN_CLI_TEXT);
    expect(result.stdout).not.toContain('::error');
    expect(result.stderr).toContain(
      'md-link-check: internal error: simulated annotation write failure',
    );
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain('::error');
  });

  it('annotation write failure does not resolve with exit 1', async () => {
    let stdout = '';
    const io: CliIo = {
      writeOut: (text) => {
        if (text.startsWith('::error ')) {
          throw new Error('simulated annotation write failure');
        }
        stdout += text;
      },
      writeError: () => undefined,
    };

    await expect(
      runSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE }, io),
    ).rejects.toThrow('simulated annotation write failure');
    expect(stdout).toContain('Checked 2 files: 9 broken targets');
    expect(stdout).not.toContain('::error');
  });

  it('annotation formatter failure emits no annotation', () => {
    const writes: string[] = [];
    const invalid: BrokenLinkResult = {
      file: 'README.md',
      line: 0,
      target: 'missing.md',
      reason: 'target does not exist',
    };

    expect(() =>
      emitAnnotations([invalid], {
        writeOut: (text) => {
          writes.push(text);
        },
        writeError: () => undefined,
      }),
    ).toThrow(RangeError);
    expect(writes).toEqual([]);
  });
});

describe('M12 direct CLI isolation', () => {
  it('direct clean CLI emits no workflow command', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const inProcess = await captureRun([M9_CLEAN_FIXTURE]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('::error');
    expect(result.stdout.split('\n').some((line) => line.startsWith('::'))).toBe(false);
    expect(inProcess.stdout).not.toContain('::error');
  });

  it('direct broken CLI emits no workflow command', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const inProcess = await captureRun([M9_BROKEN_FIXTURE]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(BROKEN_CLI_TEXT);
    expect(result.stdout).not.toContain('::error');
    expect(result.stdout.split('\n').some((line) => line.startsWith('::'))).toBe(false);
    expect(inProcess.stdout).toContain(`docs/missing.md${SEPARATOR}target does not exist`);
    expect(inProcess.stdout).not.toContain('::error');
  });

  it('direct usage-error CLI emits no workflow command', async () => {
    const result = await runCli([], { cwd: M9_CLEAN_FIXTURE });
    const inProcess = await captureRun([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(USAGE_TEXT);
    expect(`${result.stdout}${result.stderr}`).not.toContain('::error');
    expect(`${inProcess.stdout}${inProcess.stderr}`).not.toContain('::error');
  });

  it('direct JSON CLI emits no workflow command', async () => {
    const broken = await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const clean = await runCli(['--json', '--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const usage = await runCli(['--json'], { cwd: M9_CLEAN_FIXTURE });

    for (const result of [broken, clean, usage]) {
      expect(result.stdout).not.toContain('::error');
      expect(result.stdout.split('\n').some((line) => line.startsWith('::'))).toBe(false);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
    expect(broken.status).toBe(1);
    expect(clean.status).toBe(0);
    expect(usage.status).toBe(2);
  });

  it('direct CLI does not invoke annotation emission', () => {
    for (const file of [
      'run.ts',
      'cli.ts',
      'report.ts',
      'checker.ts',
      'parser.ts',
      'discovery.ts',
      'external.ts',
      'scheduler.ts',
    ]) {
      const source = readFileSync(join(REPO_ROOT, 'src', file), 'utf8');
      expect(source).not.toMatch(/annotation\.js|formatAnnotation/);
    }
  });

  it('direct CLI frozen text remains byte-for-byte unchanged', async () => {
    const broken = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const clean = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const usage = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    expect(broken.stdout).toBe(BROKEN_CLI_TEXT);
    expect(broken.stderr).toBe('');
    expect(clean.stdout).toBe(CLEAN_CLI_TEXT);
    expect(clean.stderr).toBe('');
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toBe(USAGE_TEXT);
  });

  it('direct CLI JSON fields remain unchanged', async () => {
    const document = JSON.parse(
      (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE })).stdout,
    ) as {
      version: number;
      exitCode: number;
      diagnostics: Array<{ file: string; line: number; target: string; reason: string }>;
      summary: { broken: number; filesChecked: number; externalSkipped: number };
    };

    expect(document.version).toBe(1);
    expect(document.exitCode).toBe(1);
    expect(Object.keys(document).sort()).toEqual([
      'diagnostics',
      'exitCode',
      'external',
      'ok',
      'summary',
      'version',
    ]);
    expect(document.diagnostics).toHaveLength(M9_BROKEN_FINDINGS.length);
    expect(
      document.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    ).toEqual(M9_BROKEN_FINDINGS.map(({ file, line, target, reason }) => ({ file, line, target, reason })));
    expect(document.summary).toEqual({
      filesChecked: 2,
      broken: M9_BROKEN_FINDINGS.length,
      externalSkipped: 1,
    });
  });

  it('direct CLI exits remain 0 1 and 2', async () => {
    expect((await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE })).status).toBe(0);
    expect((await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE })).status).toBe(1);
    expect((await runCli([], { cwd: M9_CLEAN_FIXTURE })).status).toBe(2);
  });
});

describe('M12 committed artifact', () => {
  it('checked-in action artifact contains the M12 integration', () => {
    const artifact = readActionArtifactText();

    expect(artifact).toContain('// src/annotation.ts');
    expect(artifact).toContain('function formatAnnotation(');
    expect(artifact).toContain('function formatAnnotations(');
    expect(artifact).toContain('function emitAnnotations(');
    expect(artifact).toContain('formatAnnotations(findings)');
  });

  it('checked-in action entrypoint annotates a broken fixture', async () => {
    const action = await runArtifactAction(M9_BROKEN_FIXTURE, { INPUT_PATHS: '.' });
    const expected = `${BROKEN_CLI_TEXT}${M9_EXPECTED_ANNOTATIONS.map(
      (annotation) => `${annotation}\n`,
    ).join('')}`;

    expect(action.status).toBe(1);
    expect(action.stderr).toBe('');
    expect(action.stdout).toBe(expected);
  });

  it('checked-in action entrypoint emits no annotation for a clean fixture', async () => {
    const action = await runArtifactAction(M9_CLEAN_FIXTURE, { INPUT_PATHS: '.' });

    expect(action.status).toBe(0);
    expect(action.stderr).toBe('');
    expect(action.stdout).toBe(CLEAN_CLI_TEXT);
    expect(action.stdout).not.toContain('::error');
  });

  it('checked-in action entrypoint emits no annotation for usage error', async () => {
    const action = await runArtifactAction(M9_CLEAN_FIXTURE, {});

    expect(action.status).toBe(2);
    expect(action.stdout).toBe('');
    expect(action.stderr).toBe(USAGE_TEXT);
    expect(`${action.stdout}${action.stderr}`).not.toContain('::error');
  });

  it('checked-in action entrypoint preserves CLI output', async () => {
    const action = await runArtifactAction(M9_BROKEN_FIXTURE, { INPUT_PATHS: '.' });

    expect(action.stdout.startsWith(BROKEN_CLI_TEXT)).toBe(true);
    expect(action.stdout.slice(BROKEN_CLI_TEXT.length)).toBe(
      M9_EXPECTED_ANNOTATIONS.map((annotation) => `${annotation}\n`).join(''),
    );
    expect(action.stderr).toBe('');
  });

  it('checked-in action entrypoint preserves exits 0 1 and 2', async () => {
    const clean = await runArtifactAction(M9_CLEAN_FIXTURE, { INPUT_PATHS: '.' });
    const broken = await runArtifactAction(M9_BROKEN_FIXTURE, { INPUT_PATHS: '.' });
    const usage = await runArtifactAction(M9_CLEAN_FIXTURE, {});

    expect(clean.status).toBe(0);
    expect(broken.status).toBe(1);
    expect(usage.status).toBe(2);
  });

  it('checked-in action entrypoint annotates a loopback external failure', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeFiles(root, { 'README.md': `# Consumer\n\n[external](${target})\n` });
    const fetchLog = join(root, 'fetch.log');

    try {
      const action = await runArtifactAction(
        root,
        { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        { fetchLog },
      );

      expect(action.status).toBe(1);
      expect(action.stdout).toContain(
        `README.md:3: ${target}${SEPARATOR}external HTTP 404`,
      );
      expect(action.stdout).toContain(
        `::error file=README.md,line=3::${target}${SEPARATOR}external HTTP 404`,
      );
      expect(annotationLineCount(action.stdout)).toBe(1);
      expect(readFileSync(fetchLog, 'utf8')).toContain('/not-found');
      expect(server.requests.map((request) => request.path)).toEqual(['/not-found']);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('checked-in action entrypoint works from a separate consumer workspace', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const consumerWorkspace = join(root, 'consumer-workspace');
    const artifactPath = copyActionRuntime(actionCheckout);
    writeFiles(consumerWorkspace, {
      'docs/broken.md': '# Broken\n\n[missing](missing.md)\n',
    });

    const action = await runArtifactAction(
      consumerWorkspace,
      { INPUT_PATHS: 'docs' },
      { artifactPath },
    );

    expect(action.status).toBe(1);
    expect(action.stdout).toContain(
      `docs/broken.md:3: missing.md${SEPARATOR}target does not exist`,
    );
    expect(action.stdout).toContain(
      `::error file=docs/broken.md,line=3::missing.md${SEPARATOR}target does not exist`,
    );
    expect(action.stdout).not.toContain(root);
    expect(existsSync(join(consumerWorkspace, 'node_modules'))).toBe(false);
    expect(existsSync(join(actionCheckout, 'node_modules'))).toBe(false);
  });

  it('checked-in action artifact is current', async () => {
    const result = await runActionBuild(['--check']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('action entrypoint is reproducible');
    expect(result.stderr).toBe('');
  });

  it('action entrypoint rebuild is byte reproducible', async () => {
    const root = makeTempRoot();
    const firstPath = join(root, 'first.cjs');
    const secondPath = join(root, 'second.cjs');

    const first = await runActionBuild(['--outfile', firstPath]);
    const second = await runActionBuild(['--outfile', secondPath]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const firstBytes = readFileSync(firstPath);
    const secondBytes = readFileSync(secondPath);
    expect(firstBytes.length).toBeGreaterThan(0);
    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(firstBytes.equals(readFileSync(ACTION_ARTIFACT_PATH))).toBe(true);
  });

  it('action reproducibility check leaves no diff', async () => {
    const before = readActionArtifactText();
    const result = await runActionBuild(['--check']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(readActionArtifactText()).toBe(before);
  });
});

describe('M12 input and metadata preservation', () => {
  it('paths action input remains unchanged', () => {
    const metadata = readActionMetadata();
    const paths = requireMapping(metadata.inputs, 'paths');

    expect(requireScalar(paths, 'required')).toBe('true');
    expect(requireScalar(paths, 'description').length).toBeGreaterThan(0);
    expect(buildCommandLine({ paths: ['README.md', 'docs'], external: false })).toEqual([
      '--',
      'README.md',
      'docs',
    ]);
    expect(buildCommandLine({ paths: ['-not-a-flag'], external: false })).toEqual([
      '--',
      '-not-a-flag',
    ]);
    expect(readActionInputs({ INPUT_PATHS: ' README.md \n\ndocs\n' })).toEqual({
      paths: ['README.md', 'docs'],
      external: false,
    });
  });

  it('external action input remains unchanged', () => {
    const metadata = readActionMetadata();
    const external = requireMapping(metadata.inputs, 'external');

    expect(requireScalar(external, 'default')).toBe('false');
    expect(requireScalar(external, 'description').length).toBeGreaterThan(0);
    expect(buildCommandLine({ paths: ['docs'], external: true })).toEqual([
      '--external',
      '--',
      'docs',
    ]);
    expect(readActionInputs({ INPUT_PATHS: 'docs', INPUT_EXTERNAL: ' True ' })).toEqual({
      paths: ['docs'],
      external: true,
    });
    expect(readActionInputs({ INPUT_PATHS: 'docs' }).external).toBe(false);
  });

  it('action metadata adds no input', () => {
    expect([...readActionMetadata().inputs.keys()].sort()).toEqual([
      'external',
      'paths',
    ]);
  });

  it('action metadata retains the M12 runtime surface', () => {
    const metadata = readActionMetadata();

    // M13 intentionally adds summary-count outputs; M12 still owns the
    // runtime surface added for annotations.
    expect([...metadata.runs.keys()]).toEqual(['using', 'main']);
  });

  it('action paths remain caller-workspace relative', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, { 'docs/broken.md': '# Broken\n\n[missing](missing.md)\n' });

    const action = await runArtifactAction(consumer, { INPUT_PATHS: 'docs' });

    expect(action.status).toBe(1);
    expect(action.stdout).toContain(
      `::error file=docs/broken.md,line=3::missing.md${SEPARATOR}target does not exist`,
    );
    expect(action.stdout).not.toContain(root);
  });

  it('external remains opt-in', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Consumer\n\n[external](${server.urlFor('/ok')})\n`,
    });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
      });

      expect(action.exitCode).toBe(0);
      expect(server.requests).toEqual([]);
      expect(action.stdout).toContain('1 external link skipped');
      expect(actionAnnotations(action)).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

describe('M12 scope and dependencies', () => {
  it('package retains zero runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const lockfile = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    ) as { packages?: Record<string, { dependencies?: Record<string, string> }> };

    expect(manifest.dependencies ?? {}).toEqual({});
    expect(lockfile.packages?.['']?.dependencies ?? {}).toEqual({});
  });

  it('M12 changes no path under github metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('M12 changes no path under project metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('M12 adds no workflow', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/workflows/'))).toEqual(
      [],
    );
  });
});
