import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this test file rather than the cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ACTION_METADATA_PATH = join(REPO_ROOT, 'action.yml');
export const ACTION_ARTIFACT_PATH = join(REPO_ROOT, 'action-dist', 'index.cjs');
export const ACTION_BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-action.mjs');
export const ACTION_SCOPE_SCRIPT = join(REPO_ROOT, 'scripts', 'check-scope.mjs');
export const ACTION_FETCH_GUARD_PATH = join(REPO_ROOT, 'test', 'action-fetch-guard.cjs');

/**
 * The JavaScript action runtime declared by action.yml. Node 20 was removed
 * from GitHub-hosted runners on 2026-09-23, so node24 is the current supported
 * runtime for a JavaScript action.
 */
export const DOCUMENTED_ACTION_RUNTIME = 'node24';

/** The M7 authorized base commit; the scope check defaults to this SHA. */
export const AUTHORIZED_BASE_SHA = '572d43da06a68c8af0cf61cde5a597c7fa56e8d5';

export interface ProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Additional CommonJS preload modules, loaded after the fetch guard. */
  requires?: readonly string[];
}

/**
 * Runs a Node script with the loopback-only fetch guard preloaded and captures
 * stdout, stderr and the exit status. The child never inherits the caller's
 * working directory unless it is passed explicitly.
 */
export async function runNode(
  scriptPath: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const env: NodeJS.ProcessEnv = options.env ?? { ...process.env };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const preloads = [ACTION_FETCH_GUARD_PATH, ...(options.requires ?? [])];

  const child = spawn(
    process.execPath,
    [...preloads.flatMap((preload) => ['--require', preload]), scriptPath, ...args],
    { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  try {
    return await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise);
      child.once('close', (status, signal) => {
        resolvePromise({ status, signal, stdout, stderr, timedOut });
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface ActionRunOptions {
  /** Caller workspace; the action runs with this as its process cwd. */
  cwd: string;
  /** Environment overrides; pass INPUT_PATHS / INPUT_EXTERNAL here. */
  inputs?: Record<string, string | undefined>;
  artifactPath?: string;
  fetchLog?: string;
  cacheHome?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Invokes the committed action artifact exactly as the GitHub runner would for
 * a JavaScript action: a Node process whose cwd is the caller workspace and
 * whose action inputs arrive through INPUT_* environment variables. The action
 * checkout is never mutated.
 */
export async function runAction(options: ActionRunOptions): Promise<ProcessResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The runner owns these variables for its own job steps, so a test child
  // starts from a clean action environment. Explicit overrides are merged last.
  for (const key of Object.keys(env)) {
    if (key.startsWith('INPUT_')) {
      delete env[key];
    }
  }
  delete env.MD_LINK_CHECK_ACTION_FETCH_LOG;

  for (const [key, value] of Object.entries(options.inputs ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  if (options.fetchLog !== undefined) {
    env.MD_LINK_CHECK_ACTION_FETCH_LOG = options.fetchLog;
  }
  if (options.cacheHome !== undefined) {
    env.XDG_CACHE_HOME = options.cacheHome;
  }
  // A test child must not append to the runner's own GITHUB_OUTPUT file.
  // Publication tests opt in through `options.env`, merged immediately below,
  // with a temporary path of their own.
  delete env.GITHUB_OUTPUT;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return runNode(options.artifactPath ?? ACTION_ARTIFACT_PATH, [], {
    cwd: options.cwd,
    env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/** Invokes the built CLI directly, after the pretest build, for comparison. */
export async function runCli(
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return runNode(join(REPO_ROOT, 'dist', 'cli.js'), args, options);
}

/** Runs the repository-local action build or reproducibility script. */
export async function runActionBuild(
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return runNode(ACTION_BUILD_SCRIPT, args, {
    cwd: REPO_ROOT,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/** Runs the repository-local M7 scope check and parses its JSON report. */
export async function readScopeReport(): Promise<{
  base: string;
  mode: 'git-diff' | 'baseline-manifest';
  changed: string[];
  violations: string[];
}> {
  const result = await runNode(ACTION_SCOPE_SCRIPT, ['--json'], { cwd: REPO_ROOT });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`scope check failed to run: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as {
    base: string;
    mode: 'git-diff' | 'baseline-manifest';
    changed: string[];
    violations: string[];
  };
}

/**
 * Copies only the metadata-declared runtime set into a temporary action
 * checkout: `action.yml` and the committed entrypoint it points at.
 */
export function copyActionRuntime(destinationRoot: string): string {
  const destinationArtifact = join(destinationRoot, 'action-dist', 'index.cjs');
  mkdirSync(join(destinationRoot, 'action-dist'), { recursive: true });
  copyFileSync(ACTION_METADATA_PATH, join(destinationRoot, 'action.yml'));
  copyFileSync(ACTION_ARTIFACT_PATH, destinationArtifact);
  return destinationArtifact;
}

/** Reads the committed action metadata text. */
export function readActionMetadataText(): string {
  return readFileSync(ACTION_METADATA_PATH, 'utf8');
}

/** Reads the committed action entrypoint text. */
export function readActionArtifactText(): string {
  return readFileSync(ACTION_ARTIFACT_PATH, 'utf8');
}

export function actionRuntimeExists(): boolean {
  return existsSync(ACTION_ARTIFACT_PATH);
}

/** True when the repository-relative path is tracked by Git. */
export function isGitTracked(relativePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export type MetadataNode = string | Map<string, MetadataNode>;

export interface ParsedActionMetadata {
  text: string;
  fields: Map<string, MetadataNode>;
  inputs: Map<string, MetadataNode>;
  runs: Map<string, MetadataNode>;
}

/**
 * A deliberately narrow parser for this repository's own `action.yml`
 * contract: nested mappings with one-line scalar values. It is not a general
 * YAML parser and rejects block scalars, tabs and unusual syntax so a metadata
 * change cannot silently pass validation.
 */
export function parseActionMetadataYaml(text: string): Map<string, MetadataNode> {
  const root = new Map<string, MetadataNode>();
  const stack: Array<{ indent: number; map: Map<string, MetadataNode> }> = [
    { indent: -1, map: root },
  ];

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? '';
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const indentMatch = /^ */.exec(rawLine);
    const indent = indentMatch === null ? 0 : indentMatch[0].length;
    const rest = rawLine.slice(indent);
    if (rest.startsWith('\t')) {
      throw new Error(`tabs are not supported in action metadata (line ${index + 1})`);
    }

    const match = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/.exec(rest);
    if (match === null) {
      throw new Error(`unsupported action metadata line ${index + 1}: ${trimmed}`);
    }
    const key = match[1];
    if (key === undefined) {
      throw new Error(`missing key on line ${index + 1}`);
    }
    const rawValue = (match[2] ?? '').trim();

    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? -1) >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined || indent <= parent.indent) {
      throw new Error(`invalid indentation in action metadata (line ${index + 1})`);
    }

    if (rawValue === '') {
      const child = new Map<string, MetadataNode>();
      parent.map.set(key, child);
      stack.push({ indent, map: child });
    } else if (rawValue === '|' || rawValue === '>') {
      throw new Error(`block scalars are not supported in action metadata (line ${index + 1})`);
    } else {
      parent.map.set(key, parseScalar(rawValue, index + 1));
    }
  }

  return root;
}

function parseScalar(rawValue: string, line: number): string {
  const first = rawValue[0];
  if (first === '"' || first === "'") {
    if (rawValue.length < 2 || rawValue[rawValue.length - 1] !== first) {
      throw new Error(`unterminated quoted value in action metadata (line ${line})`);
    }
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

export function readActionMetadata(): ParsedActionMetadata {
  const text = readActionMetadataText();
  const fields = parseActionMetadataYaml(text);
  return {
    text,
    fields,
    inputs: requireMapping(fields, 'inputs'),
    runs: requireMapping(fields, 'runs'),
  };
}

export function requireMapping(
  parent: Map<string, MetadataNode>,
  key: string,
): Map<string, MetadataNode> {
  const value = parent.get(key);
  if (!(value instanceof Map)) {
    throw new Error(`action metadata field "${key}" must be a mapping`);
  }
  return value;
}

export function requireScalar(parent: Map<string, MetadataNode>, key: string): string {
  const value = parent.get(key);
  if (typeof value !== 'string') {
    throw new Error(`action metadata field "${key}" must be a scalar value`);
  }
  return value;
}

export function optionalScalar(
  parent: Map<string, MetadataNode>,
  key: string,
): string | undefined {
  const value = parent.get(key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`action metadata field "${key}" must be a scalar value`);
  }
  return value;
}

/**
 * Extracts the input names from the README's tagged-ref action example. The
 * example is the first YAML code block that consumes
 * `mec-org/md-link-check@`; `with:` keys are the four-space-indented mappings.
 */
export function readReadmeActionExampleInputs(): string[] {
  const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const blocks = [...readme.matchAll(/```yaml\r?\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? '',
  );
  const example = blocks.find((block) => block.includes('uses: mec-org/md-link-check@'));
  if (example === undefined) {
    throw new Error('README has no tagged-ref action YAML example');
  }

  const lines = example.split(/\r?\n/);
  const withIndex = lines.findIndex((line) => line.trim() === 'with:');
  if (withIndex === -1) {
    throw new Error('README action example has no with: block');
  }

  const inputs = new Set<string>();
  for (const line of lines.slice(withIndex + 1)) {
    if (line.trim() === '') {
      continue;
    }
    const match = /^ {4}([A-Za-z0-9_-]+):/.exec(line);
    if (match !== null) {
      const key = match[1];
      if (key !== undefined) {
        inputs.add(key);
      }
      continue;
    }
    if (/^ {0,3}\S/.test(line)) {
      break;
    }
  }
  return [...inputs].sort();
}
