import { readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  checkExternalOccurrences,
  type ExternalCheckOptions,
  type ExternalOccurrence,
  type ExternalTargetResult,
} from './external.js';
import { collectDocumentAnchors } from './headings.js';
import {
  scanHtml,
  scanMarkdown,
  type HtmlTargetReference,
  type LinkKind,
  type MarkdownScan,
} from './parser.js';
import { classifyTarget } from './target.js';

const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const COUNTED_EXTERNAL = /^https?:/i;

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  kind: LinkKind;
  target: string;
  reason: string;
}

/**
 * Summary of the external-checking part of a run. External source occurrences
 * are always counted; network requests happen only when checking is enabled.
 */
export interface ExternalSummary {
  /** Whether `--external` enabled network checking for this run. */
  enabled: boolean;
  /** Number of supported HTTP(S) link and image occurrences. */
  occurrences: number;
  /** Number of HTTP(S) occurrences skipped because checking was disabled. */
  skipped: number;
  /** Number of distinct normalized targets checked; 0 when disabled. */
  distinctChecked: number;
  /** Distinct targets whose final HTTP outcome was successful. */
  succeeded: number;
  /** Distinct targets that ended as broken links. */
  failed: number;
  /** Number of source occurrences reported as broken through a failed target. */
  brokenOccurrences: number;
  /** One structured result per distinct checked target, in first-occurrence order. */
  results: ExternalTargetResult[];
}

/** Everything one checking run produced, ready for either reporter. */
export interface CheckResult {
  /** Broken targets and undefined references, in deterministic document order. */
  diagnostics: Diagnostic[];
  /** Number of unique files that were checked. */
  filesChecked: number;
  /** Number of diagnostics (broken targets plus undefined references). */
  broken: number;
  /** Number of skipped HTTP(S) link and image uses. */
  externalSkipped: number;
  /** External-check summary counts and structured per-target results. */
  external: ExternalSummary;
}

/**
 * One link or image use in document order, before a reference-style definition
 * is resolved. Raw HTML uses already carry their destination.
 */
type PendingTarget =
  | {
      readonly style: 'direct';
      readonly kind: LinkKind;
      readonly target: string;
      readonly line: number;
      readonly column: number;
    }
  | {
      readonly style: 'reference';
      readonly kind: LinkKind;
      readonly label: string;
      readonly labelText: string;
      readonly line: number;
      readonly column: number;
    };

interface CheckPlan {
  readonly filesChecked: number;
  /**
   * In document order: either a finished local diagnostic or an external
   * occurrence whose diagnostic (if any) is only known after network checks.
   */
  readonly entries: CheckPlanEntry[];
}

type CheckPlanEntry =
  | { readonly kind: 'finding'; readonly diagnostic: Diagnostic }
  | { readonly kind: 'external'; readonly occurrence: ExternalOccurrence };

/**
 * Checks every relative link and image target in the given Markdown files, then
 * the heading anchors and explicit `<a id>`/`<a name>` anchors of fragment-only
 * targets and of relative Markdown targets that exist. This covers Markdown
 * forms and the supported raw HTML forms (`<a href>` and `<img src>`). Use sites
 * from both scanners are checked in document order.
 *
 * HTTP(S) targets are counted as skipped and are never fetched. This is the
 * default, fully offline path; use `checkMarkdownWithExternal` for `--external`.
 *
 * Reference-style uses are resolved through their definition in the same
 * document, and are reported at the use site. Every broken target is collected;
 * checking does not stop at the first one.
 *
 * Anchors are cached per resolved file path for one run. The cache stores
 * completed anchor sets, so duplicate-numbering state never crosses documents.
 */
export function checkMarkdown(files: readonly string[]): CheckResult {
  const plan = collectCheckPlan(files);
  const occurrences = externalOccurrencesOf(plan);
  const diagnostics = plan.entries.flatMap((entry) =>
    entry.kind === 'finding' ? [entry.diagnostic] : [],
  );

  return {
    diagnostics,
    filesChecked: plan.filesChecked,
    broken: diagnostics.length,
    externalSkipped: occurrences.length,
    external: {
      enabled: false,
      occurrences: occurrences.length,
      skipped: occurrences.length,
      distinctChecked: 0,
      succeeded: 0,
      failed: 0,
      brokenOccurrences: 0,
      results: [],
    },
  };
}

/**
 * Like `checkMarkdown`, but checks each distinct HTTP(S) target with the
 * injected (by default built-in) fetch, and turns every failed source
 * occurrence into an ordinary broken-link diagnostic. Duplicate occurrences
 * share one request. External failures never suppress local diagnostics, and
 * diagnostics keep document order regardless of response completion order.
 */
export async function checkMarkdownWithExternal(
  files: readonly string[],
  options: ExternalCheckOptions = {},
): Promise<CheckResult> {
  const plan = collectCheckPlan(files);
  const occurrences = externalOccurrencesOf(plan);
  const outcome = await checkExternalOccurrences(occurrences, options);

  const diagnostics: Diagnostic[] = [];
  let occurrenceIndex = 0;
  let brokenOccurrences = 0;

  for (const entry of plan.entries) {
    if (entry.kind === 'finding') {
      diagnostics.push(entry.diagnostic);
      continue;
    }

    const result = outcome.byOccurrence[occurrenceIndex];
    occurrenceIndex += 1;
    if (result === undefined || result.status !== 'failed') {
      continue;
    }
    brokenOccurrences += 1;
    diagnostics.push({ ...entry.occurrence, reason: externalFailureReason(result) });
  }

  const succeeded = outcome.results.filter((result) => result.status === 'succeeded').length;

  return {
    diagnostics,
    filesChecked: plan.filesChecked,
    broken: diagnostics.length,
    externalSkipped: 0,
    external: {
      enabled: true,
      occurrences: occurrenceIndex,
      skipped: 0,
      distinctChecked: outcome.results.length,
      succeeded,
      failed: outcome.results.length - succeeded,
      brokenOccurrences,
      results: outcome.results,
    },
  };
}

/**
 * Compatibility wrapper for callers that only need the diagnostics. It never
 * performs network access; new code should use `checkMarkdown`, which also
 * reports the summary counts.
 */
export function checkMarkdownFiles(files: readonly string[]): Diagnostic[] {
  return checkMarkdown(files).diagnostics;
}

/** Collects local diagnostics and external occurrences in document order. */
function collectCheckPlan(files: readonly string[]): CheckPlan {
  const entries: CheckPlanEntry[] = [];
  const documentAnchors = new Map<string, ReadonlySet<string>>();

  for (const file of files) {
    const markdown = readFileSync(file, 'utf8');
    const sourceAnchors = anchorsOf(file, markdown, documentAnchors);
    const markdownScan = scanMarkdown(markdown);
    const htmlScan = scanHtml(markdown);

    for (const use of documentOrder(markdownScan, htmlScan.references)) {
      let target: string;
      if (use.style === 'reference') {
        const definition = markdownScan.definitions.get(use.label);
        if (definition === undefined) {
          entries.push({
            kind: 'finding',
            diagnostic: {
              file,
              line: use.line,
              column: use.column,
              kind: use.kind,
              target: use.labelText,
              reason: 'reference definition does not exist',
            },
          });
          continue;
        }
        target = definition.target;
      } else {
        target = use.target;
      }

      if (isCountedExternal(target)) {
        entries.push({
          kind: 'external',
          occurrence: {
            file,
            line: use.line,
            column: use.column,
            kind: use.kind,
            target,
          },
        });
        continue;
      }

      const diagnostic = checkTarget(
        file,
        target,
        use.kind,
        use.line,
        use.column,
        sourceAnchors,
        documentAnchors,
      );
      if (diagnostic !== null) {
        entries.push({ kind: 'finding', diagnostic });
      }
    }
  }

  return { filesChecked: files.length, entries };
}

function externalOccurrencesOf(plan: CheckPlan): ExternalOccurrence[] {
  return plan.entries.flatMap((entry) => (entry.kind === 'external' ? [entry.occurrence] : []));
}

/**
 * Builds the stable diagnostic reason for a failed distinct target. Attempt
 * counts appear only when a retry happened; no error object or platform text is
 * ever included.
 */
function externalFailureReason(result: ExternalTargetResult): string {
  const suffix = `${result.attempts} ${result.attempts === 1 ? 'attempt' : 'attempts'}`;

  switch (result.failureKind) {
    case 'http': {
      const status = result.httpStatus === undefined ? 'error' : String(result.httpStatus);
      return result.attempts > 1
        ? `external HTTP ${status} after ${suffix}`
        : `external HTTP ${status}`;
    }
    case 'timeout':
      return `external request timed out after ${suffix}`;
    case 'network':
      return `external network failure after ${suffix}`;
    case 'invalid-url':
      return 'external invalid URL';
    default:
      return 'external check failed';
  }
}

/**
 * Merges Markdown reference-style uses, Markdown inline uses and raw HTML uses
 * into one deterministic document-order list. Ordering by line then column
 * preserves the scanner's document order and lets both scanners agree on one
 * diagnostic sequence.
 */
function documentOrder(
  markdownScan: MarkdownScan,
  htmlReferences: readonly HtmlTargetReference[],
): PendingTarget[] {
  const uses: PendingTarget[] = [];

  for (const reference of markdownScan.references) {
    if (reference.style === 'reference') {
      uses.push({
        style: 'reference',
        kind: reference.kind,
        label: reference.label,
        labelText: reference.labelText,
        line: reference.line,
        column: reference.column,
      });
      continue;
    }
    uses.push({
      style: 'direct',
      kind: reference.kind,
      target: reference.target,
      line: reference.line,
      column: reference.column,
    });
  }

  for (const reference of htmlReferences) {
    uses.push({
      style: 'direct',
      kind: reference.kind,
      target: reference.target,
      line: reference.line,
      column: reference.column,
    });
  }

  return uses.sort((left, right) => left.line - right.line || left.column - right.column);
}

/** True for a skipped HTTP(S) use; other schemes are skipped but not counted. */
function isCountedExternal(target: string): boolean {
  return COUNTED_EXTERNAL.test(target.trim());
}

function checkTarget(
  file: string,
  target: string,
  kind: LinkKind,
  line: number,
  column: number,
  sourceAnchors: ReadonlySet<string>,
  documentAnchors: Map<string, ReadonlySet<string>>,
): Diagnostic | null {
  const trimmed = target.trim();

  if (trimmed.startsWith('#')) {
    const fragment = decodeFragment(trimmed.slice(1));
    if (fragment !== '' && !sourceAnchors.has(fragment)) {
      return { file, line, column, kind, target, reason: 'anchor does not exist' };
    }
    return null;
  }

  const classification = classifyTarget(target);
  if (classification.kind !== 'relative') {
    return null;
  }

  const targetPath = resolve(dirname(file), classification.path);
  const stats = statOf(targetPath);
  if (stats === null) {
    return { file, line, column, kind, target, reason: 'target does not exist' };
  }

  const fragment = classification.fragment;
  if (fragment === null || fragment === '') {
    return null;
  }
  if (!stats.isFile() || !MARKDOWN_FILE.test(classification.path)) {
    return null;
  }

  const targetAnchors = anchorsOf(targetPath, null, documentAnchors);
  if (!targetAnchors.has(decodeFragment(fragment))) {
    return { file, line, column, kind, target, reason: 'anchor does not exist' };
  }
  return null;
}

/**
 * Collects and caches the anchor names one document defines: heading slugs plus
 * explicit `<a id>`/`<a name>` values. The cache stores completed sets, so
 * duplicate-numbering state never crosses documents.
 */
function anchorsOf(
  file: string,
  markdown: string | null,
  cache: Map<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const key = resolve(file);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const contents = markdown ?? readFileSync(key, 'utf8');
  const anchors: ReadonlySet<string> = new Set(collectDocumentAnchors(contents));
  cache.set(key, anchors);
  return anchors;
}

function statOf(targetPath: string): Stats | null {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}

/**
 * Decodes a percent-encoded fragment before comparing it with heading slugs and
 * explicit HTML anchors. A fragment that is not valid percent-encoding is
 * compared as written.
 */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
