/**
 * Shared fixtures, independent expectation oracles and small parsers for the
 * M22 offline/external summary coverage packet.
 *
 * The expected summaries, CLI text, annotation lines and output records here are
 * hard-coded oracles: none is rendered by a production formatter. The external
 * oracle applies the established M18 escaping to the actual bound network URL
 * explicitly so it stays independent of the implementation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAction as runSourceAction } from '../src/action-runner.js';
import type { CliIo, RunResult } from '../src/run.js';
import { runAction, type ProcessResult } from './action-helpers.js';

/** Proxy variables a hosted runner could inject; removed for every run. */
export const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

/** Proxy variables as explicit child-environment removals. */
export const PROXY_ISOLATION: Record<string, undefined> = Object.fromEntries(
  PROXY_VARIABLES.map((name) => [name, undefined]),
);

/** The exact M21 warning for a destination that rejects the append. */
export const WRITE_FAILED_WARNING =
  '::warning::GITHUB_STEP_SUMMARY could not be written; no job summary was written.\n';

/** The exact M21 warning for an unset or empty destination. */
export const UNAVAILABLE_WARNING =
  '::warning::GITHUB_STEP_SUMMARY is not set; no job summary was written.\n';

/** The three authoritative M17 counts of one completed check. */
export interface Counts {
  readonly filesChecked: number;
  readonly broken: number;
  readonly externalSkipped: number;
}

/** One broken finding, independently expected from the fixture. */
export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly reason: string;
}

/** The complete independently expected result of one mode. */
export interface ModeExpectation {
  readonly counts: Counts;
  readonly findings: readonly Finding[];
  readonly cliText: string;
  readonly annotations: readonly string[];
  readonly listedDiagnostics: readonly string[];
  readonly summary: string;
  readonly outputs: string;
}

/**
 * The default offline fixture. Line 3 resolves, line 4 is a missing local
 * target, lines 5 and 6 are HTTP and HTTPS targets that default mode must skip
 * without fetching, line 7 is a missing anchor, and the second file contributes
 * one more local finding after the first file's result order.
 */
export function offlineFixture(baseUrl: string): Record<string, string> {
  const secureTarget = `https://127.0.0.1:${new URL(baseUrl).port}/secure`;
  return {
    'README.md': [
      '# M22 offline fixture',
      '',
      '[guide](docs/guide.md)',
      '[missing](docs/missing.md)',
      `[site](${baseUrl}/ok)`,
      `[secure](${secureTarget})`,
      '[anchor](#no-such-heading)',
      '',
    ].join('\n'),
    'docs/guide.md': '# Guide\n\n[back](../README.md)\n[gone](not-there.md)\n',
  };
}

/**
 * The external fixture. Lines 3 and 4 are the loopback server's existing healthy
 * and broken routes; lines 5 and 6 keep local findings after and around the
 * external result so the summary's document-order diagnostics are observable.
 */
export function externalFixture(baseUrl: string): Record<string, string> {
  return {
    'README.md': [
      '# M22 external fixture',
      '',
      `[healthy](${baseUrl}/ok)`,
      `[broken](${baseUrl}/not-found)`,
      '[missing](docs/missing.md)',
      '[guide](docs/guide.md)',
      '',
    ].join('\n'),
    'docs/guide.md': '# Guide\n\n[back](../README.md)\n[gone](not-there.md)\n',
  };
}

const OFFLINE_LISTED_DIAGNOSTICS = [
  '- README.md:4: docs/missing.md — target does not exist',
  '- README.md:7: \\#no\\-such\\-heading — anchor does not exist',
  '- docs/guide.md:4: not\\-there.md — target does not exist',
] as const;

export const OFFLINE_EXPECTATION: ModeExpectation = {
  counts: { filesChecked: 2, broken: 3, externalSkipped: 2 },
  findings: [
    { file: 'README.md', line: 4, target: 'docs/missing.md', reason: 'target does not exist' },
    { file: 'README.md', line: 7, target: '#no-such-heading', reason: 'anchor does not exist' },
    { file: 'docs/guide.md', line: 4, target: 'not-there.md', reason: 'target does not exist' },
  ],
  cliText: [
    'README.md:4: docs/missing.md — target does not exist',
    'README.md:7: #no-such-heading — anchor does not exist',
    'docs/guide.md:4: not-there.md — target does not exist',
    'Checked 2 files: 3 broken targets, 2 external links skipped.',
    '',
  ].join('\n'),
  annotations: [
    '::error file=README.md,line=4::docs/missing.md — target does not exist',
    '::error file=README.md,line=7::#no-such-heading — anchor does not exist',
    '::error file=docs/guide.md,line=4::not-there.md — target does not exist',
  ],
  listedDiagnostics: OFFLINE_LISTED_DIAGNOSTICS,
  summary: [
    '## Results',
    '',
    '- Checked: 2',
    '- Broken: 3',
    '- External skipped: 2',
    '',
    '## Diagnostics',
    '',
    ...OFFLINE_LISTED_DIAGNOSTICS,
    '',
  ].join('\n'),
  outputs: 'files-checked=2\nbroken=3\nexternal-skipped=2\n',
};

/**
 * The external-mode expectation. The loopback URL is built from the actual bound
 * address and ephemeral port; the summary applies the established M18 escaping
 * to that URL by hand, so the oracle stays independent of the formatter.
 */
export function externalExpectation(baseUrl: string): ModeExpectation {
  const port = new URL(baseUrl).port;
  const brokenTarget = `${baseUrl}/not-found`;
  const listedDiagnostics = [
    `- README.md:4: http\\://127.0.0.1\\:${port}/not\\-found — external HTTP 404`,
    '- README.md:5: docs/missing.md — target does not exist',
    '- docs/guide.md:4: not\\-there.md — target does not exist',
  ];
  return {
    counts: { filesChecked: 2, broken: 3, externalSkipped: 0 },
    findings: [
      { file: 'README.md', line: 4, target: brokenTarget, reason: 'external HTTP 404' },
      { file: 'README.md', line: 5, target: 'docs/missing.md', reason: 'target does not exist' },
      { file: 'docs/guide.md', line: 4, target: 'not-there.md', reason: 'target does not exist' },
    ],
    cliText: [
      `README.md:4: ${brokenTarget} — external HTTP 404`,
      'README.md:5: docs/missing.md — target does not exist',
      'docs/guide.md:4: not-there.md — target does not exist',
      'Checked 2 files: 3 broken targets, 0 external links skipped.',
      'External checks: 2 occurrences, 2 distinct targets checked (1 succeeded, 1 failed), 1 broken occurrence.',
      '',
    ].join('\n'),
    annotations: [
      `::error file=README.md,line=4::${brokenTarget} — external HTTP 404`,
      '::error file=README.md,line=5::docs/missing.md — target does not exist',
      '::error file=docs/guide.md,line=4::not-there.md — target does not exist',
    ],
    listedDiagnostics,
    summary: [
      '## Results',
      '',
      '- Checked: 2',
      '- Broken: 3',
      '- External skipped: 0',
      '',
      '## Diagnostics',
      '',
      ...listedDiagnostics,
      '',
    ].join('\n'),
    outputs: 'files-checked=2\nbroken=3\nexternal-skipped=0\n',
  };
}

/** The exact stdout of one action run: unchanged CLI text, then annotations. */
export function actionStdout(expectation: ModeExpectation): string {
  return `${expectation.cliText}${expectation.annotations.join('\n')}\n`;
}

/** Complete warning lines in one captured stream. */
export function warningLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('::warning::'));
}

/** Physical annotation lines in one captured stream, in order. */
export function annotationLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('::error '));
}

/** Occurs exactly once when exactly one summary fragment was appended. */
export function summaryOccurrences(summary: string): number {
  return summary.split('## Results').length - 1;
}

/** The listed diagnostics of one hard-coded summary, in order. */
export function summaryDiagnostics(summary: string): string[] {
  const marker = '## Diagnostics\n\n';
  const start = summary.indexOf(marker);
  if (start === -1) {
    return [];
  }
  return summary
    .slice(start + marker.length)
    .split('\n')
    .filter((line) => line.startsWith('- '));
}

/** Every HTTP(S) target written in one fixture's Markdown files. */
export function fixtureExternalTargets(fixture: string): string[] {
  const targets: string[] = [];
  for (const file of ['README.md', 'docs/guide.md']) {
    const contents = readFileSync(join(fixture, file), 'utf8');
    for (const match of contents.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      const target = match[1];
      if (target !== undefined) {
        targets.push(target);
      }
    }
  }
  return targets;
}

/** Parses the loopback-only action fetch guard's log, one entry per attempt. */
export function readFetchLog(path: string): Array<{ decision: string; url: string }> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const separator = line.indexOf(' ');
      return {
        decision: line.slice(0, separator),
        url: line.slice(separator + 1),
      };
    });
}

export interface SourceInvocationOptions {
  readonly fixture: string;
  readonly external: 'true' | 'false' | undefined;
  readonly summaryPath: string;
  readonly outputPath: string;
  readonly cacheHome: string;
}

export interface SourceInvocation {
  readonly result: RunResult;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the in-process action orchestration against a fixture, with the process
 * working directory temporarily moved into that fixture exactly as the action
 * child's `cwd` is. Process-wide cache and proxy variables are isolated and
 * restored; the action's own inputs, summary and output arrive through the
 * environment object the wrapper already takes.
 */
export async function invokeSourceAction(
  options: SourceInvocationOptions,
): Promise<SourceInvocation> {
  writeFileSync(options.summaryPath, '');
  writeFileSync(options.outputPath, '');
  const environment: NodeJS.ProcessEnv = {
    INPUT_PATHS: '.',
    GITHUB_OUTPUT: options.outputPath,
    GITHUB_STEP_SUMMARY: options.summaryPath,
  };
  if (options.external !== undefined) {
    environment.INPUT_EXTERNAL = options.external;
  }

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

  const savedCacheHome = process.env.XDG_CACHE_HOME;
  const savedProxy = PROXY_VARIABLES.map(
    (name) => [name, process.env[name]] as const,
  );
  const savedCwd = process.cwd();
  process.env.XDG_CACHE_HOME = options.cacheHome;
  for (const name of PROXY_VARIABLES) {
    delete process.env[name];
  }
  process.chdir(options.fixture);
  try {
    const result = await runSourceAction(environment, io);
    return { result, stdout, stderr };
  } finally {
    process.chdir(savedCwd);
    for (const [name, value] of savedProxy) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    if (savedCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedCacheHome;
    }
  }
}

export interface ArtifactInvocationOptions {
  readonly fixture: string;
  readonly external: 'true' | 'false' | undefined;
  /** A writable summary destination, or `undefined` for the M21 absent case. */
  readonly summaryPath: string | undefined;
  readonly outputPath: string;
  readonly fetchLog: string;
  readonly cacheHome: string;
}

export interface ArtifactInvocation {
  readonly result: ProcessResult;
}

/**
 * Runs the committed action bundle exactly as the hosted runner does, with a
 * writable temporary summary and output file, a fresh cache home and the
 * loopback-only fetch guard. Proxy variables from the host are removed so they
 * cannot redirect the fixture traffic.
 */
export async function invokeArtifact(
  options: ArtifactInvocationOptions,
): Promise<ArtifactInvocation> {
  writeFileSync(options.outputPath, '');
  if (options.summaryPath !== undefined) {
    writeFileSync(options.summaryPath, '');
  }
  const inputs: Record<string, string | undefined> = { INPUT_PATHS: '.' };
  if (options.external !== undefined) {
    inputs.INPUT_EXTERNAL = options.external;
  }
  const result = await runAction({
    cwd: options.fixture,
    inputs,
    env: {
      ...PROXY_ISOLATION,
      GITHUB_OUTPUT: options.outputPath,
      GITHUB_STEP_SUMMARY: options.summaryPath,
    },
    fetchLog: options.fetchLog,
    cacheHome: options.cacheHome,
  });
  return { result };
}
