import type { Diagnostic } from './checker.js';

/** M0's readable one-line diagnostic; polished formatting is a later milestone. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: ${diagnostic.target} — ${diagnostic.reason}`;
}
