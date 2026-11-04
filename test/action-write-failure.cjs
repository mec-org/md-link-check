'use strict';
/**
 * Test-only preload used when the action entrypoint runs in a child process.
 *
 * It simulates an unexpected failure while the action writes workflow-command
 * annotations: every ordinary stdout write (the CLI's own diagnostics and
 * summary) succeeds, but the first annotation write throws. The action
 * entrypoint must then follow the CLI's existing internal-error contract
 * instead of reporting a broken-link exit code or fabricating a finding.
 */
const originalWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = function failingAnnotationWrite(chunk, ...rest) {
  const text = typeof chunk === 'string' ? chunk : String(chunk);
  if (text.startsWith('::error ')) {
    throw new Error('simulated annotation write failure');
  }
  return originalWrite(chunk, ...rest);
};
