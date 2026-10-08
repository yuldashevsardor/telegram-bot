export type FontFacts = {
    glyphCount: number;
    familyName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    // The advance width by the encoded code point; its keys are the set of encoded code points.
    advanceWidths: Map<number, number>;
};

// The encoded code points are a fact of their own: the keys of the advance widths.
export type FactName = keyof FontFacts | "codePoints";
