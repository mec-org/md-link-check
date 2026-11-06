# M18 — Summary values and Markdown escaping

Base: `bedfcde1e6b080645094a87d7d0c7b8f0d7bcd4c` (M17, #46).

M18 adds one internal, pure utility that escapes a single untrusted value so a
later milestone can place it inside one inline Markdown summary entry. The
escaped value is for file names, link targets and failure reasons. M18 does not
wire the utility into the GitHub Action and writes no job summary; M19 is
expected to pass every value through it, and M20 writes the summary.

## Module and export

`src/summary-markdown.ts` exports:

- `escapeSummaryValue(value: string): string` — escapes one value;
- `SUMMARY_VALUE_MAX_EXPANSION` — the documented expansion bound (`6`).

The module has no runtime imports, reads no environment, performs no I/O and
adds no runtime dependency. It iterates the input by Unicode code point, so
surrogate pairs and other non-ASCII text are never split or rewritten.

## Encoding rules

One input code point produces one output; the table shows both the escaped
source and what a reader sees after GitHub renders the summary as GFM.

```text
input               raw output     rendered text
\                   \\\\           \\
`                   \`             `
|                   \|             |
*                   \*             *
_                   \_             _
[                   \[             [
]                   \]             ]
<                   &lt;           <
>                   &gt;           >
&                   &amp;          &
#                   \#             #
~                   \~             ~
-                   \-             -
+                   \+             +
:                   \:             :
www.                www\.          www.
1. / 1) marker      1\. / 1\)      1. / 1)
LF                  \n             \n   (two visible characters)
CR                  \r             \r   (two visible characters)
TAB                 \t             \t   (two visible characters)
other C0 / DEL      \uXXXX         \uXXXX
anything else       unchanged      unchanged
```

Notes:

- **Rendered backslash distinction.** A literal backslash is written as four
  backslashes, which GFM renders as two visible backslashes. That is what keeps
  literal escape-like text distinguishable from an encoded control *in the
  rendered summary*: literal input `\n` renders as `\\n` (two backslashes and
  `n`), while an actual LF renders as `\n` (one backslash and `n`). Doubling
  only the source backslash would render both as `\n` and defeat the
  representation. The same holds for `\r`, `\t` and `\u0000`.
- **Strikethrough and emphasis.** `~` is escaped so `~~text~~` cannot become
  strikethrough; `*` and `_` are escaped so they cannot emphasise. All three
  render back as themselves.
- **Extended autolinks.** `:` is escaped, which breaks the `http://` and
  `https://` source patterns that GFM would auto-link, and the dot of `www.` is
  escaped wherever it follows `www` (case-insensitively). Both render back as
  the original visible text. GFM's bare-email autolink (see the limitation
  below) cannot be prevented this way.
- **Block structure.** The output has no raw line break, so a value cannot
  introduce a new line, paragraph or table row. `>` becomes `&gt;`, `#` is
  escaped anywhere, backticks and pipes are escaped, and `-`, `+` are escaped
  so a value that starts a line cannot become a list item or thematic break.
  An ordered-list marker at the start of the value (up to three leading spaces,
  1–9 digits, then `.` or `)` and whitespace) has that punctuation escaped;
  `1.2` and a marker away from the start are ordinary text.
- **Angle brackets and ampersand.** `<` and `>` become `&lt;` and `&gt;`, so
  they cannot open raw HTML or an autolink. `&` becomes `&amp;`, so input such
  as `&lt;` stays the four literal characters it was instead of rendering as
  `<`; entity-like text cannot collide with an encoded bracket.
- **Line breaks and controls.** LF, CR and TAB have the visible sequences
  above; U+0000–U+001F not covered by those and U+007F use the fixed-width
  `\uXXXX` form. No raw line break or covered control remains.
- **Everything else** — ordinary text and all non-ASCII characters — is
  emitted unchanged. Nothing is deleted, trimmed, collapsed, reordered or
  truncated.
- **Empty input** maps to the empty string.

### Known limitation

GitHub's GFM renderer turns a bare email address such as `user@example.com`
into a `mailto:` link. Backslash-escaping the `@` or writing it as a character
reference still renders `@`, and GitHub still auto-links the rendered text
(checked against GitHub's Markdown API), so preventing that link would require
changing the visible value, which M18 forbids. M18 therefore covers the
required bracket links and the `http://`, `https://` and `www.` autolinks;
bare-email links remain a documented limitation of rendering-driven GFM.

## Guarantees

- **One physical line.** The output contains no raw CR, LF, TAB, C0 control or
  DEL character.
- **Meaning and order.** Every input character remains represented, in order,
  by itself or by its documented encoding. Every escape except the literal
  backslash renders back to the character it replaced; a literal backslash
  renders as two visible backslashes so it stays distinguishable from the
  control encodings, and controls render as visible sequences corresponding to
  the original control characters.
- **Deterministic.** The same input always produces the same output.
- **Bounded.** Each input UTF-16 code unit produces at most
  `SUMMARY_VALUE_MAX_EXPANSION` (6) output UTF-16 code units, so
  `escapeSummaryValue(value).length <= 6 * value.length` for every string,
  including the empty string. The longest encoding is the six-code-unit
  `\uXXXX` control form, and the bound is tight for repeated U+0000. The value
  is always escaped in full; M18 defines no truncation.

## Tests

`test/summary-markdown.test.ts` covers each required character class with
literal expected strings, plus an independent inline-text renderer that
resolves backslash escapes and character references the way CommonMark does:

1. `escapes Markdown structural punctuation` — backticks, pipes, asterisks,
   underscores, brackets and angle brackets;
2. `escapes an ampersand so entity-like text stays literal`;
3. `escapes a leading heading marker` — a leading `#` and a `#` away from the
   leading position;
4. `neutralises GFM strikethrough and extended autolinks` — `~~`, `http://`,
   `https://`, `www.`, and the rendered-text check;
5. `neutralises leading list and block markers` — `-`, `+`, `1.`, `1)`, three
   leading spaces, thematic break, block quote, heading, and non-marker cases;
6. `encodes line breaks as visible text on one line` — LF, CR and CRLF;
7. `encodes tabs and control characters without deletion` — TAB, U+0000, an
   interior C0 control, U+001F and U+007F;
8. `distinguishes literal escape-like text from encoded controls` — literal
   `\`, `\n`, `\r`, `\t` and `\u0000` against the encoded controls, both raw
   and rendered;
9. `preserves mixed value meaning in one escaped entry` — one representative
   value with every special class and a CRLF, exact escaped and rendered text;
10. `has bounded deterministic expansion` — the bound for every specially
    encoded character, mixed and repeated worst-case input, identical repeat
    calls;
11. `preserves non-ASCII text unchanged`;
12. `leaves ordinary values unchanged`;
13. `renders escaped punctuation back to the visible source text`;
14. `handles the empty string`.

## Not connected to the action

`src/summary-markdown.ts` is not imported by `src/action.ts`,
`src/action-runner.ts`, `src/action-outputs.ts`, the CLI, or any other
production module. M18 writes no job summary and changes no CLI text or JSON,
annotation, action output, action input or exit behavior. The checked-in
`action-dist/index.cjs` is unchanged because the utility is outside the action
execution path, and the existing M17 v0.3 surface-regression tests remain
byte-for-byte unchanged.
