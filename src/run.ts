import { checkMarkdownFiles } from './checker.js';
import { discoverMarkdownFiles, InputError } from './discovery.js';
import { formatDiagnostic } from './report.js';

export interface CliIo {
  writeOut(text: string): void;
  writeError(text: string): void;
}

const USAGE = 'Usage: md-link-check <path> [path…]\n';

/**
 * Runs the CLI and returns its exit code: 0 when every checked target exists,
 * 1 when at least one is broken. Exit code 2 for usage errors is deferred to
 * the interface milestone, so argument problems currently exit 1 as well.
 */
export function run(args: readonly string[], io: CliIo): number {
  if (args.length === 0) {
    io.writeError(USAGE);
    return 1;
  }

  let files: string[];
  try {
    files = discoverMarkdownFiles(args);
  } catch (error) {
    if (error instanceof InputError) {
      io.writeError(`md-link-check: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const diagnostics = checkMarkdownFiles(files);
  for (const diagnostic of diagnostics) {
    io.writeOut(`${formatDiagnostic(diagnostic)}\n`);
  }
  return diagnostics.length === 0 ? 0 : 1;
}
