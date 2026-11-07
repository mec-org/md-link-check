/**
 * M23 — deterministic multi-file hardening fixture and independent oracles.
 *
 * The fixture is built textually by this module rather than committed as a
 * large tree: it spans three Markdown files and deliberately mixes relative
 * file links, relative image links, same-file anchors, cross-file anchors,
 * repeated headings, duplicated missing targets, skipped external links and a
 * loopback external base URL. One mode adds a compact escaping fixture whose
 * file names and targets carry Markdown-sensitive and control characters.
 *
 * Every expected finding, count, CLI line, summary line and diagnostic-order
 * list is derived from this module's own fixture definition, never from the
 * production result. The expected summary applies the documented M18 escaping
 * table through an independent implementation below, so a formatter regression
 * changes the actual output without changing the oracle.
 */

/** The exact M23 authorized base commit from the milestone packet. */
export const M23_BASE_SHA = 'd8b312a79866291e0550d2fbdb9d68f192e39ead';

/**
 * The order of the forty generated README targets. `17` and `40` are coprime,
 * so this is a permutation of 1..40 whose sequence is deliberately not sorted:
 * proving that the formatter preserves document order rather than sorting by
 * target.
 */
const GENERATED_TARGET_ORDER: readonly number[] = Array.from(
  { length: 40 },
  (_, index) => ((index * 17) % 40) + 1,
);

/** The three authoritative counts of the default offline mode. */
export const M23_OFFLINE_COUNTS = Object.freeze({
  filesChecked: 3,
  broken: 67,
  externalSkipped: 2,
});

/** The three authoritative counts of the loopback external mode. */
export const M23_EXTERNAL_COUNTS = Object.freeze({
  filesChecked: 3,
  broken: 68,
  externalSkipped: 0,
});

/** One independently expected structured finding. */
export interface M23Finding {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly reason: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Builds the multi-file fixture. `externalBaseUrl` must be a loopback origin
 * in every test that can reach the network; in the default offline mode the
 * two external uses are never fetched, whatever origin is supplied.
 */
export function hardeningFixture(externalBaseUrl: string): Record<string, string> {
  const generated = GENERATED_TARGET_ORDER.map(
    (targetNumber, index) =>
      `[generated ${index + 1}](generated/target${pad(targetNumber)}.md)`,
  );
  const extra = Array.from(
    { length: 10 },
    (_, index) => `[missing ${pad(index + 1)}](gone${pad(index + 1)}.md)`,
  );
  // Two later uses of the same missing target: both must stay in the result,
  // in source order, with no deduplication or grouping.
  extra.push('[duplicate](gone01.md)', '[duplicate again](gone01.md)');
  const guideImages = Array.from(
    { length: 10 },
    (_, index) => `![lost ${pad(index + 1)}](images/lost${pad(index + 1)}.png)`,
  );

  return {
    'README.md': [
      '# M23 hardening fixture',
      '',
      '[guide](docs/guide.md)',
      '[missing file](docs/missing.md)',
      '![missing image](images/missing.png)',
      '[missing same anchor](#no-such-heading)',
      '[missing cross anchor](docs/guide.md#no-such-anchor)',
      `[healthy external](${externalBaseUrl}/ok)`,
      `[broken external](${externalBaseUrl}/not-found)`,
      '',
      ...generated,
      '',
    ].join('\n'),
    'docs/extra.md': ['# Extra', '', ...extra, ''].join('\n'),
    'docs/guide.md': [
      '# Guide',
      '',
      '## Repeat',
      '## Repeat',
      '',
      '[repeat one](#repeat)',
      '[repeat two](#repeat-1)',
      '[repeat missing](#repeat-2)',
      ...guideImages,
      '',
    ].join('\n'),
  };
}

/**
 * The default offline findings, in the CLI's deterministic result order:
 * README.md, docs/extra.md, docs/guide.md, each in document order. The
 * repeated `## Repeat` headings give guide.md a real `#repeat` and `#repeat-1`
 * anchor; only `#repeat-2` is missing.
 */
export function offlineFindings(): readonly M23Finding[] {
  const findings: M23Finding[] = [
    { file: 'README.md', line: 4, target: 'docs/missing.md', reason: 'target does not exist' },
    { file: 'README.md', line: 5, target: 'images/missing.png', reason: 'target does not exist' },
    { file: 'README.md', line: 6, target: '#no-such-heading', reason: 'anchor does not exist' },
    {
      file: 'README.md',
      line: 7,
      target: 'docs/guide.md#no-such-anchor',
      reason: 'anchor does not exist',
    },
  ];
  GENERATED_TARGET_ORDER.forEach((targetNumber, index) => {
    findings.push({
      file: 'README.md',
      line: 11 + index,
      target: `generated/target${pad(targetNumber)}.md`,
      reason: 'target does not exist',
    });
  });
  for (let index = 1; index <= 10; index += 1) {
    findings.push({
      file: 'docs/extra.md',
      line: 2 + index,
      target: `gone${pad(index)}.md`,
      reason: 'target does not exist',
    });
  }
  findings.push(
    { file: 'docs/extra.md', line: 13, target: 'gone01.md', reason: 'target does not exist' },
    { file: 'docs/extra.md', line: 14, target: 'gone01.md', reason: 'target does not exist' },
  );
  findings.push({
    file: 'docs/guide.md',
    line: 8,
    target: '#repeat-2',
    reason: 'anchor does not exist',
  });
  for (let index = 1; index <= 10; index += 1) {
    findings.push({
      file: 'docs/guide.md',
      line: 8 + index,
      target: `images/lost${pad(index)}.png`,
      reason: 'target does not exist',
    });
  }
  return findings;
}

/**
 * The findings of the loopback external mode: the same local findings plus the
 * single broken external occurrence at README.md line 9, in document order.
 */
export function externalFindings(externalBaseUrl: string): readonly M23Finding[] {
  const local = offlineFindings();
  return [
    ...local.slice(0, 4),
    {
      file: 'README.md',
      line: 9,
      target: `${externalBaseUrl}/not-found`,
      reason: 'external HTTP 404',
    },
    ...local.slice(4),
  ];
}

/** The fixture's complete text-mode output for one completed check. */
export function expectedCliText(
  findings: readonly M23Finding[],
  counts: { readonly filesChecked: number; readonly broken: number; readonly externalSkipped: number },
  externalMode: boolean,
): string {
  const diagnostics = findings
    .map((finding) => `${finding.file}:${finding.line}: ${finding.target} — ${finding.reason}\n`)
    .join('');
  const checked = counts.filesChecked === 1 ? 'file' : 'files';
  const broken = counts.broken === 1 ? 'broken target' : 'broken targets';
  const skipped = counts.externalSkipped === 1 ? 'external link' : 'external links';
  let text =
    `${diagnostics}Checked ${counts.filesChecked} ${checked}: ` +
    `${counts.broken} ${broken}, ${counts.externalSkipped} ${skipped} skipped.\n`;
  if (externalMode) {
    text +=
      'External checks: 2 occurrences, 2 distinct targets checked ' +
      '(1 succeeded, 1 failed), 1 broken occurrence.\n';
  }
  return text;
}

/** One workflow-command annotation line for a simple fixture finding. */
export function expectedAnnotation(finding: M23Finding): string {
  return `::error file=${finding.file},line=${finding.line}::` +
    `${finding.target} — ${finding.reason}`;
}

/** The complete action stdout: unchanged CLI text, then annotations. */
export function expectedActionStdout(
  findings: readonly M23Finding[],
  counts: { readonly filesChecked: number; readonly broken: number; readonly externalSkipped: number },
  externalMode: boolean,
): string {
  return expectedCliText(findings, counts, externalMode) +
    `${findings.map(expectedAnnotation).join('\n')}\n`;
}

/** The exact `GITHUB_OUTPUT` bytes published by a completed check. */
export function expectedOutputs(counts: {
  readonly filesChecked: number;
  readonly broken: number;
  readonly externalSkipped: number;
}): string {
  return (
    `files-checked=${counts.filesChecked}\n` +
    `broken=${counts.broken}\n` +
    `external-skipped=${counts.externalSkipped}\n`
  );
}

/**
 * Independent implementation of the documented M18 summary escaping table.
 * Deliberately separate from `src/summary-markdown.ts`: a change to the
 * production escaper must change the actual summary without silently changing
 * this oracle.
 */
export function escapeSummaryValueOracle(value: string): string {
  const orderedMarker = /^ {0,3}[0-9]{1,9}[.)](?=\s|$)/.exec(value);
  const orderedMarkerIndex = orderedMarker === null ? -1 : orderedMarker[0].length - 1;
  const leadingSpaces = /^ +/.exec(value)?.[0].length ?? 0;
  const encodeLeadingSpaces = leadingSpaces >= 4;

  let escaped = '';
  let index = 0;
  for (const character of value) {
    if (character === ' ' && index < leadingSpaces && encodeLeadingSpaces) {
      escaped += '&#32;';
      index += character.length;
      continue;
    }
    escaped +=
      index === orderedMarkerIndex && (character === '.' || character === ')')
        ? `\\${character}`
        : character === '.' && value.slice(Math.max(0, index - 3), index).toLowerCase() === 'www'
          ? '\\.'
          : escapeCharacterOracle(character);
    index += character.length;
  }
  return escaped;
}

function escapeCharacterOracle(character: string): string {
  switch (character) {
    case '\\':
      return '\\\\\\\\';
    case '`':
      return '\\`';
    case '|':
      return '\\|';
    case '*':
      return '\\*';
    case '_':
      return '\\_';
    case '[':
      return '\\[';
    case ']':
      return '\\]';
    case '<':
      return '&lt;';
    case '>':
      return '&gt;';
    case '&':
      return '&amp;';
    case '#':
      return '\\#';
    case '~':
      return '\\~';
    case '-':
      return '\\-';
    case '+':
      return '\\+';
    case ':':
      return '\\:';
    case '=':
      return '\\=';
    case '$':
      return '\\u0024';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default: {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 0x1f || codePoint === 0x7f) {
        return `\\u${codePoint.toString(16).padStart(4, '0')}`;
      }
      return character;
    }
  }
}

/** One escaped summary diagnostic entry. */
export function expectedSummaryDiagnostic(finding: M23Finding): string {
  return (
    `- ${escapeSummaryValueOracle(finding.file)}:${finding.line}: ` +
    `${escapeSummaryValueOracle(finding.target)} — ` +
    `${escapeSummaryValueOracle(finding.reason)}`
  );
}

/** The complete expected summary Markdown for one completed check. */
export function expectedSummary(
  counts: { readonly filesChecked: number; readonly broken: number; readonly externalSkipped: number },
  findings: readonly M23Finding[],
  limit = 50,
): string {
  const lines = [
    '## Results',
    '',
    `- Checked: ${counts.filesChecked}`,
    `- Broken: ${counts.broken}`,
    `- External skipped: ${counts.externalSkipped}`,
  ];
  const listed = findings.slice(0, limit);
  if (listed.length > 0) {
    lines.push('', '## Diagnostics', '');
    lines.push(...listed.map(expectedSummaryDiagnostic));
  }
  if (findings.length > limit) {
    lines.push(
      '',
      `${findings.length} total diagnostics; ${findings.length - limit} not listed.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The listed diagnostic entries of one summary, in order. */
export function listedDiagnostics(summary: string): string[] {
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

/** Occurs exactly once when exactly one summary fragment was appended. */
export function summaryOccurrences(summary: string): number {
  return summary.split('## Results').length - 1;
}

/**
 * The escaping fixture: two Markdown files whose file names and targets carry
 * Markdown punctuation, table-sensitive characters, a line break, a tab and a
 * C0 control. File names are representable on POSIX filesystems, so the real
 * discovery and action path produces them exactly as a hostile document could.
 */
// The fixture file name intentionally carries a raw C0 control at runtime (the
// source spells it with a TS escape); it exercises a value a hostile document
// could contain on a POSIX filesystem.
export const ESCAPING_WEIRD_FILE =
  'docs/weird|line\nbreak\ttab`tick*[x]&<y>\u0001.md';
export const ESCAPING_WEIRD_TARGET = 'missing_*|[]&<>.md';
export const ESCAPING_ANCHOR_TARGET = '#mi_ss-|[]<>&*~$';

export function escapingFixture(): Record<string, string> {
  return {
    'README.md': [
      '# Escape anchors',
      '',
      `[bad anchor](${ESCAPING_ANCHOR_TARGET})`,
      '',
    ].join('\n'),
    [ESCAPING_WEIRD_FILE]: [
      '# Escape fixture',
      '',
      `[missing target](${ESCAPING_WEIRD_TARGET})`,
      '',
    ].join('\n'),
  };
}

/** The two independently expected findings of {@link escapingFixture}. */
export const ESCAPING_FINDINGS: readonly M23Finding[] = Object.freeze([
  { file: 'README.md', line: 3, target: ESCAPING_ANCHOR_TARGET, reason: 'anchor does not exist' },
  { file: ESCAPING_WEIRD_FILE, line: 3, target: ESCAPING_WEIRD_TARGET, reason: 'target does not exist' },
]);

/**
 * The six visible characters backslash-u-0001 used for the fixture's C0
 * control. Building the escape from its code points keeps the source free of
 * a raw control byte and makes the expected bytes unambiguous.
 */
const C0_VISIBLE_ESCAPE = String.fromCharCode(0x5c) + 'u0001';

/** The exact escaped entry for the control-character file name. */
const ESCAPING_FILE_ENTRY =
  '- docs/weird\\|line\\nbreak\\ttab\\`tick\\*\\[x\\]&amp;&lt;y&gt;' +
  `${C0_VISIBLE_ESCAPE}.md:3: ` +
  'missing\\_\\*\\|\\[\\]&amp;&lt;&gt;.md — target does not exist';

/** The exact escaped entry for the Markdown-punctuation anchor. */
const ESCAPING_ANCHOR_ENTRY =
  '- README.md:3: \\#mi\\_ss\\-\\|\\[\\]&lt;&gt;&amp;\\*\\~\\u0024 — anchor does not exist';

/** The complete expected summary for {@link escapingFixture}. */
export const ESCAPING_SUMMARY = [
  '## Results',
  '',
  '- Checked: 2',
  '- Broken: 2',
  '- External skipped: 0',
  '',
  '## Diagnostics',
  '',
  ESCAPING_ANCHOR_ENTRY,
  ESCAPING_FILE_ENTRY,
].join('\n') + '\n';
