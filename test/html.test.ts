import { describe, expect, it } from 'vitest';
import { collectDocumentAnchors } from '../src/headings.js';
import { scanHtml, scanMarkdown } from '../src/parser.js';

/** Reduces raw HTML references to compact assertion objects. */
function htmlReferences(markdown: string) {
  return scanHtml(markdown).references.map(({ kind, target, line }) => ({ kind, target, line }));
}

/** Reduces explicit HTML anchors to compact assertion objects. */
function explicitAnchors(markdown: string) {
  return scanHtml(markdown).anchors.map(({ value, line }) => ({ value, line }));
}

describe('raw HTML scanning', () => {
  it('finds a double-quoted raw HTML link', () => {
    expect(htmlReferences('<a href="docs/guide.md">the guide</a>')).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
    ]);
  });

  it('finds a single-quoted raw HTML link', () => {
    expect(htmlReferences("<a href='docs/guide.md'>the guide</a>")).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
    ]);
  });

  it('finds an unquoted raw HTML link', () => {
    expect(htmlReferences('<a href=docs/guide.md>the guide</a>')).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
    ]);
  });

  it('finds a double-quoted raw HTML image', () => {
    expect(htmlReferences('<img src="assets/logo.png" alt="Logo">')).toEqual([
      { kind: 'image', target: 'assets/logo.png', line: 1 },
    ]);
  });

  it('finds a single-quoted raw HTML image', () => {
    expect(htmlReferences("<img src='assets/logo.png' alt='Logo'>")).toEqual([
      { kind: 'image', target: 'assets/logo.png', line: 1 },
    ]);
  });

  it('finds an unquoted raw HTML image', () => {
    expect(htmlReferences('<img src=assets/logo.png alt=Logo>')).toEqual([
      { kind: 'image', target: 'assets/logo.png', line: 1 },
    ]);
  });

  it('matches HTML tag names case-insensitively', () => {
    expect(htmlReferences('<A HREF="docs/guide.md">guide</A> <IMG SRC="assets/logo.png">')).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
      { kind: 'image', target: 'assets/logo.png', line: 1 },
    ]);
  });

  it('matches HTML attribute names case-insensitively', () => {
    expect(htmlReferences('<a HrEf="docs/guide.md">guide</a> <img SrC="assets/logo.png">')).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
      { kind: 'image', target: 'assets/logo.png', line: 1 },
    ]);
    expect(explicitAnchors('<a ID="Section"></a> <a NaMe="Other">')).toEqual([
      { value: 'Section', line: 1 },
      { value: 'Other', line: 1 },
    ]);
  });

  it('finds relevant attributes in any order', () => {
    const markdown = [
      '<a class="nav" href="docs/guide.md" title="Guide">guide</a>',
      '<a title="Section" id="section" class="anchor">anchor</a>',
      '<img alt="Diagram" src="assets/diagram.png" width="400">',
    ].join('\n');

    expect(htmlReferences(markdown)).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
      { kind: 'image', target: 'assets/diagram.png', line: 3 },
    ]);
    expect(explicitAnchors(markdown)).toEqual([{ value: 'section', line: 2 }]);
  });

  it('allows unrelated attributes around the relevant attribute', () => {
    expect(
      htmlReferences(
        '<a data-track="nav" aria-label="Guide" href="docs/guide.md" class="nav" title="Guide">guide</a>',
      ),
    ).toEqual([{ kind: 'link', target: 'docs/guide.md', line: 1 }]);
    expect(
      htmlReferences('<img alt="Diagram" width="400" height="200" src="assets/diagram.png">'),
    ).toEqual([{ kind: 'image', target: 'assets/diagram.png', line: 1 }]);
  });

  it('does not match data-href as href', () => {
    expect(htmlReferences('<a data-href="docs/missing.md">guide</a>')).toEqual([]);
    expect(htmlReferences('<img data-src="assets/missing.png">')).toEqual([]);
    expect(explicitAnchors('<a data-name="section"></a>')).toEqual([]);
    expect(explicitAnchors('<a name-extra="section"></a>')).toEqual([]);
  });

  it('ignores empty href and src values', () => {
    expect(htmlReferences('<a href="">guide</a>')).toEqual([]);
    expect(htmlReferences("<a href=''>guide</a>")).toEqual([]);
    expect(htmlReferences('<img src="">')).toEqual([]);
    expect(htmlReferences('<img src=>')).toEqual([]);
  });

  it('does not match srcset as src', () => {
    expect(htmlReferences('<img srcset="small.png 1x, large.png 2x">')).toEqual([]);
  });

  it('ignores href on non-anchor tags', () => {
    expect(
      htmlReferences('<div href="missing.md"></div><img href="missing.png"><link href="style.css">'),
    ).toEqual([]);
  });

  it('ignores src on non-image tags', () => {
    expect(
      htmlReferences('<video src="movie.mp4"></video><script src="app.js"></script><a src="x.png">'),
    ).toEqual([]);
  });

  it('ignores unsupported raw HTML tags', () => {
    const markdown = [
      '<div id="section"><span name="span-name"></span></div>',
      '<h2 id="heading">Heading</h2>',
      '<video src="movie.mp4" poster="movie.jpg"></video>',
      '<source src="movie.ogg">',
      '<a:foo href="missing.md">namespaced</a:foo>',
      '<img-something src="missing.png">',
    ].join('\n');

    expect(scanHtml(markdown)).toEqual({ anchors: [], references: [] });
  });

  it('uses a deterministic rule for duplicate relevant attributes', () => {
    expect(htmlReferences('<a href="first.md" href="second.md">guide</a>')).toEqual([
      { kind: 'link', target: 'first.md', line: 1 },
    ]);
    expect(htmlReferences('<img src="first.png" src="second.png">')).toEqual([
      { kind: 'image', target: 'first.png', line: 1 },
    ]);
    expect(explicitAnchors('<a id="first" id="second" name="third"></a>')).toEqual([
      { value: 'first', line: 1 },
      { value: 'third', line: 1 },
    ]);
  });

  it('does not emit one HTML target twice', () => {
    expect(htmlReferences('<a href="docs/guide.md">the guide</a>')).toHaveLength(1);
    expect(htmlReferences('<a id="section" name="section" href="docs/guide.md">guide</a>')).toHaveLength(1);
    expect(htmlReferences('<img src="assets/logo.png" alt="Logo">')).toHaveLength(1);
  });

  it('does not end a tag at a > inside a quoted value', () => {
    expect(htmlReferences('<a title="a > b" href="docs/guide.md">guide</a>')).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
    ]);
    expect(htmlReferences("<img alt='a > b' src='assets/logo.png'>")).toEqual([
      { kind: 'image', target: 'assets/logo.png', line: 1 },
    ]);
  });

  it('tolerates whitespace around the equals sign and a self-closing image', () => {
    expect(htmlReferences('<a href = "docs/guide.md">guide</a>')).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1 },
    ]);
    expect(htmlReferences('<img src="assets/logo.png" />')).toEqual([
      { kind: 'image', target: 'assets/logo.png', line: 1 },
    ]);
  });

  it('ignores an unclosed raw HTML tag', () => {
    expect(scanHtml('<a href="docs/guide.md"')).toEqual({ anchors: [], references: [] });
  });

  it('ignores supported raw HTML inside code', () => {
    const markdown = [
      '```html',
      '<a href="fenced-missing.md">fenced</a>',
      '<a id="fenced"></a>',
      '```',
      '',
      '    <img src="indented-missing.png">',
      '',
      'Use `<a href="inline-missing.md">inline</a>` and `<a id="inline"></a>`.',
    ].join('\n');

    expect(scanHtml(markdown)).toEqual({ anchors: [], references: [] });
  });

  it('does not also scan a supported HTML attribute as Markdown', () => {
    const markdown = '<a title="[fake](missing.md)" href="docs/guide.md">[real](other.md)</a>';
    const scan = scanMarkdown(markdown);

    expect(
      scan.references.flatMap((reference) =>
        reference.style === 'inline' ? [reference.target] : [],
      ),
    ).toEqual(['other.md']);
    expect(scan.definitions.size).toBe(0);
    expect(scanMarkdown('<a title="[docs]: missing.md"></a>').definitions.size).toBe(0);
  });

  it('keeps a supported tag on the source line in its reported line number', () => {
    const markdown = ['# Project', '', '<a href="docs/missing.md">guide</a>'].join('\n');
    expect(htmlReferences(markdown)).toEqual([
      { kind: 'link', target: 'docs/missing.md', line: 3 },
    ]);
  });
});

describe('explicit HTML anchor collection', () => {
  it('collects an explicit anchor from a id', () => {
    expect(explicitAnchors('<a id="section"></a>')).toEqual([{ value: 'section', line: 1 }]);
  });

  it('collects an explicit anchor from a name', () => {
    expect(explicitAnchors('<a name="section"></a>')).toEqual([{ value: 'section', line: 1 }]);
  });

  it('collects quoted and unquoted explicit anchor values', () => {
    const markdown = [
      '<a id="double"></a>',
      "<a id='single'></a>",
      '<a id=bare></a>',
    ].join('\n');

    expect(explicitAnchors(markdown)).toEqual([
      { value: 'double', line: 1 },
      { value: 'single', line: 2 },
      { value: 'bare', line: 3 },
    ]);
  });

  it('collects explicit anchors with mixed tag and attribute casing', () => {
    expect(explicitAnchors('<A ID="Section"></A>\n<a NaMe="Other"></a>')).toEqual([
      { value: 'Section', line: 1 },
      { value: 'Other', line: 2 },
    ]);
  });

  it('collects id and name regardless of attribute ordering', () => {
    const idFirst = explicitAnchors('<a id="first" name="second"></a>');
    const nameFirst = explicitAnchors('<a name="second" id="first"></a>');

    expect(idFirst).toEqual([
      { value: 'first', line: 1 },
      { value: 'second', line: 1 },
    ]);
    expect(nameFirst).toEqual(idFirst);
  });

  it('collects both id and name when both are present', () => {
    expect(explicitAnchors('<a id="one" name="two"></a>')).toEqual([
      { value: 'one', line: 1 },
      { value: 'two', line: 1 },
    ]);
    expect(explicitAnchors('<a name="two" id="one"></a>')).toEqual([
      { value: 'one', line: 1 },
      { value: 'two', line: 1 },
    ]);
  });

  it('does not slugify an explicit anchor value', () => {
    const anchors = collectDocumentAnchors('<a id="My Section"></a>');

    expect(anchors).toContain('My Section');
    expect(anchors).not.toContain('my-section');
  });

  it('does not suffix repeated explicit anchor values', () => {
    expect(collectDocumentAnchors('<a id="repeat"></a>\n<a name="repeat"></a>')).toEqual(['repeat']);
  });

  it('does not collect an empty explicit anchor', () => {
    expect(explicitAnchors('<a id=""></a>\n<a name=\'\'></a>\n<a id= ></a>')).toEqual([]);
    expect(collectDocumentAnchors('<a id=""></a>')).toEqual([]);
  });

  it('does not collect id from unsupported HTML elements', () => {
    const markdown = [
      '<div id="div-id"></div>',
      '<h2 id="heading-id">Heading</h2>',
      '<span id="span-id"></span>',
    ].join('\n');

    expect(explicitAnchors(markdown)).toEqual([]);
  });

  it('augments heading anchors with explicit anchors', () => {
    expect(collectDocumentAnchors('# Installation\n\n<a id="Details"></a>')).toEqual([
      'installation',
      'Details',
    ]);
  });
});
