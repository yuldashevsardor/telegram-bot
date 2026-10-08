export type FontFacts = {
    glyphCount: number;
    familyName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    // The advance width by the encoded code point; its keys are the set of encoded code points.
    advanceWidths: Map<number, number>;
};

export type FactName = "glyphCount" | "codePoints" | "familyName" | "unitsPerEm" | "ascent" | "descent" | "advanceWidths";
