export type FontFacts = {
    glyphCount: number;
    familyName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    // The advance widths of the glyphs encoded at a code point, in ascending order, by the code point;
    // its keys are the set of encoded code points.
    advanceWidths: Map<number, Array<number>>;
};

// The encoded code points are a fact of their own: the keys of the advance widths. So is the number
// of glyphs encoded at each of them: the length of its widths.
export type FactName = keyof FontFacts | "codePoints" | "glyphsPerCodePoint";
