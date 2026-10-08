import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontFacts } from "test/conversion/font-facts-reader.types";

const NON_SVG_EXTENSIONS = [Extension.TTF, Extension.OTF, Extension.WOFF, Extension.WOFF2, Extension.EOT];

// The share of the em fontforge gives the ascent of an SVG font whose ascent and descent it does not
// accept; the descent is the rest of the em. Measured at units-per-em 2048: 1638 and 410.
const SVG_FALLBACK_ASCENT_SHARE = 0.8;

export type ExpectedDifference = {
    fromExtensions: Array<Extension>;
    toExtensions: Array<Extension>;
    // The facts of the result built from those of the source: what is not changed here has to come
    // out equal to the source.
    resultFacts: (sourceFacts: FontFacts) => FontFacts;
    reason: string;
};

// The differences a pair is allowed, measured on the fixtures with fontforge 20230101. Any other
// difference fails the check, and so does a listed one that no longer happens or comes out with
// another value: the list follows the engine, not the other way round.
export const expectedDifferences: Array<ExpectedDifference> = [
    {
        fromExtensions: NON_SVG_EXTENSIONS,
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts) => ({ ...sourceFacts, glyphCount: sourceFacts.glyphCount + 1 }),
        reason:
            "One glyph more: fontforge writes glyph 0 into an SVG font twice, as the <missing-glyph> element SVG keeps " +
            "apart from the glyphs and as an ordinary <glyph>, and reads both back.",
    },
    {
        fromExtensions: NON_SVG_EXTENSIONS,
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts) => {
            const fallbackAscent = Math.round(sourceFacts.unitsPerEm * SVG_FALLBACK_ASCENT_SHARE);

            return { ...sourceFacts, ascent: fallbackAscent, descent: sourceFacts.unitsPerEm - fallbackAscent };
        },
        reason:
            'fontforge writes the descent of <font-face> negative (descent="-512"), and on reading takes the pair only ' +
            "when ascent and descent add up to units-per-em. Otherwise it falls back to 80 and 20 per cent of the em, " +
            "so the written values do not come back.",
    },
    {
        fromExtensions: [Extension.SVG],
        toExtensions: [Extension.TTF, Extension.EOT, Extension.WOFF2],
        resultFacts: (sourceFacts) => ({ ...sourceFacts, glyphCount: sourceFacts.glyphCount + 1 }),
        reason:
            "One glyph more: writing TrueType outlines, fontforge adds the empty .null glyph, which the SVG fixture " +
            "does not have. The pairs that come out with CFF outlines, svg to otf and to woff, gain nothing.",
    },
];
