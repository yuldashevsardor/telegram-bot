import { Extension } from "app/font-convertor/font-convertor.types";
import type { FactName } from "test/conversion/font-facts-reader.types";

const NON_SVG_EXTENSIONS = [Extension.TTF, Extension.OTF, Extension.WOFF, Extension.WOFF2, Extension.EOT];

export type ExpectedDifference = {
    fromExtensions: Array<Extension>;
    toExtensions: Array<Extension>;
    facts: Array<FactName>;
    reason: string;
};

// The facts a pair is allowed to change, measured on the fixtures with fontforge 20230101. Any other
// difference fails the check, and so does a listed one that no longer happens: the list follows the
// engine, not the other way round.
export const expectedDifferences: Array<ExpectedDifference> = [
    {
        fromExtensions: NON_SVG_EXTENSIONS,
        toExtensions: [Extension.SVG],
        facts: ["glyphCount"],
        reason:
            "One glyph more: fontforge writes glyph 0 into an SVG font twice, as the <missing-glyph> element SVG keeps " +
            "apart from the glyphs and as an ordinary <glyph>, and reads both back.",
    },
    {
        fromExtensions: NON_SVG_EXTENSIONS,
        toExtensions: [Extension.SVG],
        facts: ["ascent", "descent"],
        reason:
            'fontforge writes the descent of <font-face> negative (descent="-512"), and on reading takes the pair only ' +
            "when ascent and descent add up to units-per-em. Otherwise it falls back to 80 and 20 per cent of the em, " +
            "1638 and 410 at 2048, so the written values do not come back.",
    },
    {
        fromExtensions: [Extension.SVG],
        toExtensions: [Extension.TTF, Extension.EOT, Extension.WOFF2],
        facts: ["glyphCount"],
        reason:
            "One glyph more: writing TrueType outlines, fontforge adds the empty .null glyph, which the SVG fixture " +
            "does not have. The pairs that come out with CFF outlines, svg to otf and to woff, gain nothing.",
    },
];
