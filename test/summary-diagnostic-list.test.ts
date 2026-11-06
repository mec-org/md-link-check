/**
 * M19 — the run-summary diagnostic list formatter.
 *
 * The formatter under test is pure. Expected Markdown is written out literally
 * (or assembled from literal fragments), never by calling the formatter or the
 * M18 escaper to build its own expectation. Simple findings avoid characters
 * that the M18 escaper rewrites, so list and boundary tests freeze the grammar
 * itself; the hostile-value test freezes the escaped representation with
 * literal expected strings and separately checks each field against the public
 * M18 escaper.
 */
import { describe, expect, it } from 'vitest';
import type { ActionSummary, BrokenLinkResult } from '../src/run.js';
import {
  escapeSummaryValue,
  formatRunSummaryMarkdown,
  SUMMARY_DIAGNOSTIC_LIMIT,
} from '../src/summary-markdown.js';
import { M17_FINDINGS, M17_SUMMARY } from './m17-helpers.js';

/**
 * Builds a distinguishable finding whose values need no Markdown escaping. The
 * padded index makes every file, target, reason and line unique, so a
 * truncation, ordering or aggregation error is observable.
 */
function simpleFinding(index: number): BrokenLinkResult {
  const label = String(index).padStart(3, '0');
  return {
    file: `docs/file${label}.md`,
    line: index + 1,
    target: `missing${label}.md`,
    reason: `target does not exist ${label}`,
  };
}

/** The exact diagnostic bullet rendered for {@link simpleFinding}. */
function simpleEntry(index: number): string {
  const label = String(index).padStart(3, '0');
  return (
    `- docs/file${label}.md:${index + 1}: ` +
    `missing${label}.md — target does not exist ${label}`
  );
}

/** Builds `count` distinct simple findings in index order. */
function simpleFindings(count: number): BrokenLinkResult[] {
  return Array.from({ length: count }, (_, index) => simpleFinding(index));
}

/** The three counts with an overridable broken count. */
function countsOf(overrides: Partial<ActionSummary> = {}): ActionSummary {
  return { filesChecked: 4, broken: 0, externalSkipped: 2, ...overrides };
}

/**
 * Returns the diagnostic bullets of a summary, structurally: the contiguous
 * `- ` lines directly after the `## Diagnostics` heading. Returns an empty list
 * when the heading is absent.
 */
function listedEntries(markdown: string): string[] {
  const marker = '\n## Diagnostics\n\n';
  const start = markdown.indexOf(marker);
  if (start === -1) {
    return [];
  }

  const entries: string[] = [];
  for (const line of markdown.slice(start + marker.length).split('\n')) {
    if (!line.startsWith('- ')) {
      break;
    }
    entries.push(line);
  }
  return entries;
}

describe('M19 diagnostic list formatter', () => {
  it('formats counts and zero diagnostics', () => {
    const markdown = formatRunSummaryMarkdown(
      { filesChecked: 12, broken: 0, externalSkipped: 3 },
      [],
    );

    expect(markdown).toBe(
      '## Results\n\n' +
        '- Checked: 12\n' +
        '- Broken: 0\n' +
        '- External skipped: 3\n',
    );
    // The counts come first and end the document; there is no empty
    // diagnostics list and no overflow disclosure.
    expect(markdown.startsWith('## Results\n\n- Checked: 12\n')).toBe(true);
    expect(listedEntries(markdown)).toEqual([]);
    expect(markdown).not.toContain('## Diagnostics');
    expect(markdown).not.toMatch(/not listed|total diagnostics/);
  });

  it('formats one diagnostic', () => {
    const finding: BrokenLinkResult = {
      file: 'docs/a.md',
      line: 7,
      target: 'missing.md',
      reason: 'target does not exist',
    };

    const markdown = formatRunSummaryMarkdown(
      { filesChecked: 12, broken: 1, externalSkipped: 3 },
      [finding],
    );

    expect(markdown).toBe(
      '## Results\n\n' +
        '- Checked: 12\n' +
        '- Broken: 1\n' +
        '- External skipped: 3\n\n' +
        '## Diagnostics\n\n' +
        '- docs/a.md:7: missing.md — target does not exist\n',
    );
    expect(listedEntries(markdown)).toEqual([
      '- docs/a.md:7: missing.md — target does not exist',
    ]);
    expect(listedEntries(markdown)).toHaveLength(1);
    expect(markdown).not.toMatch(/not listed|total diagnostics/);
  });

  it('lists exactly fifty diagnostics', () => {
    expect(SUMMARY_DIAGNOSTIC_LIMIT).toBe(50);

    const findings = simpleFindings(SUMMARY_DIAGNOSTIC_LIMIT);
    const markdown = formatRunSummaryMarkdown(
      countsOf({ broken: SUMMARY_DIAGNOSTIC_LIMIT }),
      findings,
    );
    const entries = listedEntries(markdown);

    expect(entries).toHaveLength(SUMMARY_DIAGNOSTIC_LIMIT);
    expect(entries).toEqual(
      findings.map((_, index) => simpleEntry(index)),
    );
    expect(markdown).toContain('- Broken: 50');
    expect(markdown).not.toMatch(/not listed|total diagnostics/);
  });

  it('limits fifty-one diagnostics and reports one not listed', () => {
    const findings = simpleFindings(51);
    const markdown = formatRunSummaryMarkdown(countsOf({ broken: 51 }), findings);
    const entries = listedEntries(markdown);

    expect(entries).toHaveLength(SUMMARY_DIAGNOSTIC_LIMIT);
    expect(entries).toEqual(
      Array.from({ length: SUMMARY_DIAGNOSTIC_LIMIT }, (_, index) =>
        simpleEntry(index),
      ),
    );
    // Index 50 is the first omitted finding: it appears as neither a bullet
    // nor any other part of the document.
    expect(entries).not.toContain(simpleEntry(50));
    expect(markdown).not.toContain('docs/file050.md');
    expect(markdown).not.toContain('missing050.md');
    // The disclosure is one final plain line after the blank line.
    expect(markdown.endsWith('\n\n51 total diagnostics; 1 not listed.\n')).toBe(
      true,
    );
    expect(markdown.match(/not listed/g)).toHaveLength(1);
  });

  it('reports the correct omitted count above fifty-one', () => {
    const findings = simpleFindings(73);
    const markdown = formatRunSummaryMarkdown(countsOf({ broken: 73 }), findings);
    const entries = listedEntries(markdown);

    expect(entries).toHaveLength(SUMMARY_DIAGNOSTIC_LIMIT);
    expect(entries).toEqual(
      Array.from({ length: SUMMARY_DIAGNOSTIC_LIMIT }, (_, index) =>
        simpleEntry(index),
      ),
    );
    expect(markdown).toContain('- Broken: 73');
    expect(markdown.endsWith('\n\n73 total diagnostics; 23 not listed.\n')).toBe(
      true,
    );
    expect(markdown).not.toContain('docs/file050.md');
    expect(markdown).not.toContain('docs/file072.md');
  });

  it('preserves supplied result order', () => {
    // The supplied order (zeta, alpha, middle) matches neither lexical file
    // order (alpha, middle, zeta) nor ascending line order (1, 3, 9).
    const findings: BrokenLinkResult[] = [
      {
        file: 'docs/zeta.md',
        line: 3,
        target: 'missingzeta.md',
        reason: 'target does not exist',
      },
      {
        file: 'docs/alpha.md',
        line: 9,
        target: 'missingalpha.md',
        reason: 'anchor does not exist',
      },
      {
        file: 'docs/middle.md',
        line: 1,
        target: 'missingmiddle.md',
        reason: 'target does not exist',
      },
    ];
    const snapshot = structuredClone(findings);

    // A mutation attempt would throw in the test's strict mode, and the
    // snapshot comparison catches any replacement or reordering.
    findings.forEach((finding) => Object.freeze(finding));
    Object.freeze(findings);

    const markdown = formatRunSummaryMarkdown(countsOf({ broken: 3 }), findings);

    expect(listedEntries(markdown)).toEqual([
      '- docs/zeta.md:3: missingzeta.md — target does not exist',
      '- docs/alpha.md:9: missingalpha.md — anchor does not exist',
      '- docs/middle.md:1: missingmiddle.md — target does not exist',
    ]);
    expect(findings).toEqual(snapshot);
    expect(findings.map((finding) => finding.file)).toEqual([
      'docs/zeta.md',
      'docs/alpha.md',
      'docs/middle.md',
    ]);
  });

  it('escapes every diagnostic value through the M18 escaper', () => {
    // Hostile Markdown, line breaks and controls are spread across all three
    // untrusted fields, including a leading `#` in the target.
    const finding: BrokenLinkResult = {
      file: 'docs/a`b|c*d_e[f]<g>#h\r\ni\u0000j.md',
      line: 4,
      target: '#target`|*_[]<>#~-+:& www.evil.example\nnext',
      reason: 'reason\t# one\nwith controls \u0007 and \u007f',
    };

    // Literal expected representations, derived from the documented M18
    // encoding table rather than from the implementation.
    const escapedFile =
      'docs/a\\`b\\|c\\*d\\_e\\[f\\]&lt;g&gt;\\#h\\r\\ni\\u0000j.md';
    const escapedTarget =
      '\\#target\\`\\|\\*\\_\\[\\]&lt;&gt;\\#\\~\\-\\+\\:&amp; ' +
      'www\\.evil.example\\nnext';
    const escapedReason =
      'reason\\t\\# one\\nwith controls \\u0007 and \\u007f';

    expect(escapeSummaryValue(finding.file)).toBe(escapedFile);
    expect(escapeSummaryValue(finding.target)).toBe(escapedTarget);
    expect(escapeSummaryValue(finding.reason)).toBe(escapedReason);

    const markdown = formatRunSummaryMarkdown(
      { filesChecked: 7, broken: 1, externalSkipped: 2 },
      [finding],
    );
    const escapedEntry =
      '- docs/a\\`b\\|c\\*d\\_e\\[f\\]&lt;g&gt;\\#h\\r\\ni\\u0000j.md:4: ' +
      '\\#target\\`\\|\\*\\_\\[\\]&lt;&gt;\\#\\~\\-\\+\\:&amp; ' +
      'www\\.evil.example\\nnext — reason\\t\\# one\\nwith controls ' +
      '\\u0007 and \\u007f';

    // One exact hard-coded hostile entry, independent of the production
    // escaper, so a coordinated regression cannot pass unnoticed.
    expect(listedEntries(markdown)).toEqual([escapedEntry]);
    expect(markdown).toBe(
      '## Results\n\n' +
        '- Checked: 7\n' +
        '- Broken: 1\n' +
        '- External skipped: 2\n\n' +
        '## Diagnostics\n\n' +
        `${escapedEntry}\n`,
    );

    // The hostile values cannot add a raw line break, tab, control or extra
    // Markdown block: the only line breaks are the fixed grammar's, and the
    // escaped entry remains exactly one bullet.
    expect(markdown).not.toContain('\r');
    expect(markdown).not.toContain('\t');
    expect(markdown).not.toContain('\u0000');
    expect(markdown.replaceAll('\n', '')).not.toMatch(
      /[\u0000-\u001f\u007f]/,
    );
    expect(markdown.match(/^## /gm)).toHaveLength(2);
    expect(markdown.split('\n')).toHaveLength(10);
    expect(escapeSummaryValue('')).toBe('');
  });

  it('uses exact deterministic Markdown grammar', () => {
    const counts: ActionSummary = {
      filesChecked: 9,
      broken: 2,
      externalSkipped: 0,
    };
    const findings: BrokenLinkResult[] = [
      {
        file: 'docs/first.md',
        line: 2,
        target: 'missingfirst.md',
        reason: 'target does not exist',
      },
      {
        file: 'docs/second.md',
        line: 10,
        target: 'missingsecond.md',
        reason: 'anchor does not exist',
      },
    ];
    const expected = [
      '## Results',
      '',
      '- Checked: 9',
      '- Broken: 2',
      '- External skipped: 0',
      '',
      '## Diagnostics',
      '',
      '- docs/first.md:2: missingfirst.md — target does not exist',
      '- docs/second.md:10: missingsecond.md — anchor does not exist',
      '',
    ].join('\n');

    const first = formatRunSummaryMarkdown(counts, findings);
    const second = formatRunSummaryMarkdown(counts, findings);

    expect(first).toBe(expected);
    expect(second).toBe(expected);
    expect(first).toBe(second);
    // Exactly one final newline, never a missing one or a trailing blank line.
    expect(first.endsWith('\n')).toBe(true);
    expect(first.endsWith('\n\n')).toBe(false);
    expect(first.split('\n')).toHaveLength(11);
  });

  it('keeps the M17 broken count equal to the formatted diagnostics total', () => {
    // Both M17 values exist: the authoritative `broken` count and the ordered
    // findings. The production seam derives them from the same run; formatting
    // them together must not produce contradictory counts or a spurious
    // omission disclosure.
    expect(M17_SUMMARY.broken).toBe(M17_FINDINGS.length);

    const markdown = formatRunSummaryMarkdown(M17_SUMMARY, M17_FINDINGS);

    expect(markdown).toContain(`- Checked: ${M17_SUMMARY.filesChecked}`);
    expect(markdown).toContain(`- Broken: ${M17_FINDINGS.length}`);
    expect(markdown).toContain(`- External skipped: ${M17_SUMMARY.externalSkipped}`);
    expect(listedEntries(markdown)).toHaveLength(M17_FINDINGS.length);
    expect(markdown).not.toMatch(/not listed|total diagnostics/);
  });

  it('does not truncate an individual diagnostic value', () => {
    const longReason = 'reason '.repeat(1_000).trim();
    const finding: BrokenLinkResult = {
      file: 'docs/long.md',
      line: 1,
      target: 'missing.md',
      reason: longReason,
    };

    const markdown = formatRunSummaryMarkdown(countsOf({ broken: 1 }), [finding]);

    expect(listedEntries(markdown)).toHaveLength(1);
    expect(markdown).toContain(`— ${escapeSummaryValue(longReason)}\n`);
    expect(escapeSummaryValue(longReason)).toHaveLength(longReason.length);
  });
});
