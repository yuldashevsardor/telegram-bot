/**
 * A stretch of the source text, `[fromIndex, toIndex)` in UTF-16 units, as the indexes of a string
 * go.
 */
export type TextSpan = {
    fromIndex: number;
    toIndex: number;
};

/**
 * A `glyph` or `missing-glyph` child of `font`, as the preparer reads it before it decides on its
 * edits: whether the font has a form-less glyph of a letter is known only once the whole file is read.
 */
export type FontGlyph = {
    name: string;
    attributes: Record<string, string>;
    // The text of each attribute together with the whitespace before it, so that cutting it out
    // leaves a well-formed tag.
    attributeSpans: Map<string, TextSpan>;
    // Where the start tag ends, before its `>` or `/>`.
    startTagEndIndex: number;
};

/** What the preparer reads of an SVG font. */
export type FontScan = {
    // `undefined` only in a file SvgFontValidator rejects.
    fontAdvance: string | undefined;
    fontGlyphs: Array<FontGlyph>;
};

/** The text that replaces a span of the source in the prepared copy; an empty span inserts it. */
export type TextEdit = TextSpan & {
    text: string;
};
