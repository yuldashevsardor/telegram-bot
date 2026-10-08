import { Extension } from "app/font-convertor/font-convertor.types";
import type { FontFacts } from "test/conversion/font-facts-reader.types";

// The source fixtures, by their path under test/fixtures/fonts (test/fixtures/fonts/README.md).
const ROBOTO_NON_SVG = ["test-font.ttf", "test-font.otf", "test-font.woff", "test-font.woff2", "test-font.eot", "test-font-compressed.eot"];
const ROBOTO_SVG = "test-font.svg";
const FONT_AWESOME_OTF = "font-awesome/FontAwesome.otf";
const FONT_AWESOME_TRUETYPE = [
    "font-awesome/fontawesome-webfont.ttf",
    "font-awesome/fontawesome-webfont.woff",
    "font-awesome/fontawesome-webfont.woff2",
    "font-awesome/fontawesome-webfont.eot",
];
const SOURCE_SANS_3 = "source-sans-3/SourceSans3-Regular.otf";
const NOTO_NASKH_ARABIC = "noto-naskh-arabic/NotoNaskhArabic-Regular.ttf";
const BUNGEE_SPICE = "bungee-spice/BungeeSpice-Regular.ttf";
const PACIFICO = "pacifico/Pacifico-latin.woff2";
const NON_SVG_FIXTURES = [
    ...ROBOTO_NON_SVG,
    FONT_AWESOME_OTF,
    ...FONT_AWESOME_TRUETYPE,
    SOURCE_SANS_3,
    NOTO_NASKH_ARABIC,
    BUNGEE_SPICE,
    PACIFICO,
];

// The share of the em fontforge gives the ascent of an SVG font whose ascent and descent it does not
// accept, dropping the fraction; the descent is the rest of the em. Measured at units-per-em 2048: 1638
// and 410, at 1792: 1433 and 359.
const SVG_FALLBACK_ASCENT_SHARE = 0.8;

// The width fontforge reads for a glyph of an SVG font that leaves horiz-adv-x out where <font> says 0
// (issue #913). Measured on fonts with units-per-em 1000.
const SVG_OMITTED_WIDTH = 1000;

// The base Arabic letters of Noto Naskh Arabic that come back from SVG only as their presentation forms.
const NOTO_NASKH_ARABIC_BASE_LETTERS = [
    0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627, 0x0628, 0x0629, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x062f, 0x0630, 0x0631,
    0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x0637, 0x0638, 0x0639, 0x063a, 0x0641, 0x0642, 0x0643, 0x0644, 0x0645, 0x0646, 0x0648, 0x064a,
    0x0671, 0x0677, 0x0679, 0x067a, 0x067b, 0x067e, 0x067f, 0x0680, 0x0683, 0x0684, 0x0686, 0x0687, 0x0688, 0x068c, 0x068d, 0x068e, 0x0691,
    0x0698, 0x06a4, 0x06a6, 0x06a9, 0x06ad, 0x06af, 0x06b1, 0x06b3, 0x06ba, 0x06bb, 0x06be, 0x06c0, 0x06c1, 0x06c5, 0x06c6, 0x06c7, 0x06c8,
    0x06c9, 0x06cb, 0x06cc, 0x06d0, 0x06d2, 0x06d3,
];

// The code points at which a glyph comes back twice from SVG. fontforge lists an alternate code point of
// a glyph, one beside its main one, once for every Unicode cmap subtable that holds it, platform 0 and
// platform 3, and writes a <glyph> for each listing into an SVG font. In Bungee Spice the main code
// points U+0162 and U+0163 come back twice as well: their glyphs have the alternates U+021A and U+021B.
const SOURCE_SANS_3_DOUBLED_CODE_POINTS = [0x00a0, 0x00ad, 0x03bc, 0x03d5, 0x2010, 0x2011, 0x207c, 0x2126, 0x2206];
const NOTO_NASKH_ARABIC_DOUBLED_CODE_POINTS = [0x00a0, 0x06f1, 0x06f3, 0x06f8, 0x06f9, 0x202f];
// U+FF41 to U+FF5A are the fullwidth a to z.
const BUNGEE_SPICE_DOUBLED_CODE_POINTS = [
    0x00a0,
    0x0162,
    0x0163,
    0x021a,
    0x021b,
    0x03bc,
    0x2002,
    0x2010,
    0x2126,
    0x2206,
    0x2215,
    0x2219,
    0xf6c3,
    ...Array.from({ length: 26 }, (_, index) => 0xff41 + index),
];

// The code points of Noto Naskh Arabic that have no <glyph> of their own in the SVG fontforge writes.
const NOTO_NASKH_ARABIC_UNWRITTEN = [0x06d5, 0xfba2, 0xfba3, 0xfbe8, 0xfbe9, 0xfef0, 0xfef3, 0xfef4];

// The changes of FontFacts the entries below share.
class FontFactsChanges {
    public withoutCodePoints(facts: FontFacts, codePoints: Array<number>): FontFacts {
        const advanceWidths = new Map(facts.advanceWidths);

        for (const codePoint of codePoints) {
            advanceWidths.delete(codePoint);
        }

        return { ...facts, advanceWidths: advanceWidths };
    }

    public withCodePoints(facts: FontFacts, widthsByCodePoint: Map<number, Array<number>>): FontFacts {
        return { ...facts, advanceWidths: new Map([...facts.advanceWidths, ...widthsByCodePoint]) };
    }

    public withZeroWidthsAs(facts: FontFacts, width: number): FontFacts {
        const advanceWidths = new Map(facts.advanceWidths);

        for (const [codePoint, widths] of advanceWidths) {
            const changedWidths = widths.map((advanceWidth) => (advanceWidth === 0 ? width : advanceWidth));

            advanceWidths.set(
                codePoint,
                changedWidths.sort((left, right) => left - right),
            );
        }

        return { ...facts, advanceWidths: advanceWidths };
    }

    public withEachGlyphTwice(facts: FontFacts, codePoints: Array<number>): FontFacts {
        const advanceWidths = new Map(facts.advanceWidths);

        for (const codePoint of codePoints) {
            const widths = advanceWidths.get(codePoint) ?? [];

            advanceWidths.set(
                codePoint,
                [...widths, ...widths].sort((left, right) => left - right),
            );
        }

        return { ...facts, advanceWidths: advanceWidths };
    }
}

const changes = new FontFactsChanges();

export type ExpectedDifference = {
    // The source fixtures the difference is measured on, by their path under test/fixtures/fonts.
    fixtures: Array<string>;
    toExtensions: Array<Extension>;
    // The facts of the result built from those of the source: what is not changed here has to come
    // out equal to the source.
    resultFacts: (sourceFacts: FontFacts) => FontFacts;
    reason: string;
};

// The differences a fixture is allowed on a pair, measured with fontforge 20230101. Any other difference
// fails the check, and so does a listed one that no longer happens or comes out with another value: the
// list follows the engine, not the other way round. A difference that is a defect names its issue and
// states the defect itself.
export const expectedDifferences: Array<ExpectedDifference> = [
    {
        fixtures: NON_SVG_FIXTURES,
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts) => ({ ...sourceFacts, glyphCount: sourceFacts.glyphCount + 1 }),
        reason:
            "One glyph more: fontforge writes glyph 0 into an SVG font twice, as the <missing-glyph> element SVG keeps " +
            "apart from the glyphs and as an ordinary <glyph>, and reads both back.",
    },
    {
        fixtures: NON_SVG_FIXTURES,
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts: FontFacts): FontFacts => {
            const fallbackAscent = Math.floor(sourceFacts.unitsPerEm * SVG_FALLBACK_ASCENT_SHARE);

            return { ...sourceFacts, ascent: fallbackAscent, descent: sourceFacts.unitsPerEm - fallbackAscent };
        },
        reason:
            'fontforge writes the descent of <font-face> negative (descent="-512"), and on reading takes the pair only ' +
            "when ascent and descent add up to units-per-em. Otherwise it falls back to 80 and 20 per cent of the em, " +
            "so the written values do not come back.",
    },
    {
        fixtures: [ROBOTO_SVG],
        toExtensions: [Extension.TTF, Extension.EOT, Extension.WOFF2],
        resultFacts: (sourceFacts) => ({ ...sourceFacts, glyphCount: sourceFacts.glyphCount + 1 }),
        reason:
            "One glyph more: writing TrueType outlines, fontforge adds the empty .null glyph, which the SVG fixture " +
            "does not have. The pairs that come out with CFF outlines, svg to otf and to woff, gain nothing.",
    },
    {
        fixtures: [FONT_AWESOME_OTF, SOURCE_SANS_3],
        toExtensions: [Extension.TTF, Extension.EOT, Extension.WOFF2],
        resultFacts: (sourceFacts) => ({ ...sourceFacts, glyphCount: sourceFacts.glyphCount + 2 }),
        reason:
            "Two glyphs more: writing TrueType outlines, fontforge adds the empty .null and nonmarkingreturn glyphs, " +
            "which these CFF fonts do not have. The pair into woff keeps the CFF outlines and gains nothing.",
    },
    {
        fixtures: [BUNGEE_SPICE],
        toExtensions: [Extension.WOFF, Extension.WOFF2],
        resultFacts: (sourceFacts) => ({ ...sourceFacts, glyphCount: sourceFacts.glyphCount + 2 }),
        reason:
            "Two glyphs more: writing TrueType outlines, fontforge adds the empty .null and nonmarkingreturn glyphs, " +
            "which the font does not have. ttf to eot gains nothing: EotPacker wraps the source without fontforge.",
    },
    {
        fixtures: [PACIFICO],
        toExtensions: [Extension.TTF, Extension.EOT, Extension.WOFF],
        resultFacts: (sourceFacts) => ({ ...sourceFacts, glyphCount: sourceFacts.glyphCount + 1 }),
        reason:
            "One glyph more: writing TrueType outlines, fontforge adds the empty .null glyph, as the font has its null " +
            "glyph under the name NULL. The pair into otf comes out with CFF outlines and gains nothing.",
    },
    {
        fixtures: FONT_AWESOME_TRUETYPE,
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts) => changes.withCodePoints(sourceFacts, new Map([[0x000d, [597]]])),
        reason:
            "U+000D more: the font has a nonmarkingreturn glyph without a code point, and fontforge reading an SVG font " +
            "gives a glyph without unicode the code point of its name (issue #913).",
    },
    {
        fixtures: [SOURCE_SANS_3],
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts: FontFacts): FontFacts => {
            const withoutEmptyGlyphs = changes.withoutCodePoints(sourceFacts, [0x034f, 0x200b, 0xfeff]);
            const withZeroWidths = changes.withZeroWidthsAs(withoutEmptyGlyphs, SVG_OMITTED_WIDTH);
            const withNamedGlyphs = changes.withCodePoints(withZeroWidths, new Map([[0xfb05, [594]]]));
            const withGlyphsTwice = changes.withEachGlyphTwice(withNamedGlyphs, SOURCE_SANS_3_DOUBLED_CODE_POINTS);

            return { ...withGlyphsTwice, glyphCount: sourceFacts.glyphCount + 15 };
        },
        reason:
            "15 glyphs more: fontforge writes a glyph once more for each listing of its alternate code point, 18 " +
            "elements more than the font has glyphs, and reads each back as a glyph of its own. Defects of reading SVG " +
            "(issue #913): the 3 empty zero-width glyphs, U+034F, U+200B and U+FEFF, are dropped; the other zero " +
            "widths come back as 1000; the f_t ligature, which has no code point, gets U+FB05 from its name.",
    },
    {
        fixtures: [NOTO_NASKH_ARABIC],
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts: FontFacts): FontFacts => {
            const withoutLostCodePoints = changes.withoutCodePoints(sourceFacts, [
                0x061c,
                0x200b,
                0xfeff,
                ...NOTO_NASKH_ARABIC_BASE_LETTERS,
                ...NOTO_NASKH_ARABIC_UNWRITTEN,
            ]);
            const withZeroWidths = changes.withZeroWidthsAs(withoutLostCodePoints, SVG_OMITTED_WIDTH);
            const withGlyphsTwice = changes.withEachGlyphTwice(withZeroWidths, NOTO_NASKH_ARABIC_DOUBLED_CODE_POINTS);
            const withOtherAlefMaksuraForms = changes.withCodePoints(withGlyphsTwice, new Map([[0x0649, [275, 292]]]));

            return { ...withOtherAlefMaksuraForms, glyphCount: sourceFacts.glyphCount + 9 };
        },
        reason:
            "9 glyphs more: fontforge writes 7 glyphs once more for each listing of their alternate code point, 14 " +
            "elements more than the font has glyphs, and on reading drops 5 empty ones, three copies of .null among " +
            "them. Defects (issue #913): 74 base letters, U+0621 to U+06D3, are written with arabic-form and read " +
            "back only as their presentation forms; U+06D5 and 7 presentation forms from U+FBA2 to U+FEF4 have no " +
            "<glyph> of their own, as their glyphs are written under the base letter with arabic-form, so U+0649 " +
            "comes back with the glyphs of U+FBE8 and U+FBE9, widths 275 and 292 instead of 618; the empty glyphs of " +
            "U+061C, U+200B and U+FEFF are dropped; the other zero widths come back as 1000.",
    },
    {
        fixtures: [BUNGEE_SPICE],
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts: FontFacts): FontFacts => {
            const withoutLostCodePoints = changes.withoutCodePoints(sourceFacts, [0x2001, 0x2003, 0x2007, 0xe189, 0xe202]);
            const withGlyphsTwice = changes.withEachGlyphTwice(withoutLostCodePoints, BUNGEE_SPICE_DOUBLED_CODE_POINTS);

            return { ...withGlyphsTwice, glyphCount: sourceFacts.glyphCount + 32 };
        },
        reason:
            "32 glyphs more: fontforge writes a glyph once more for each listing of its alternate code point, 76 " +
            "elements more than the font has glyphs, and on reading drops 44 empty ones. Defects (issue #913): the " +
            "spaces U+2001, U+2003, U+2007 and U+E189, empty glyphs whose width equals the 1000 of <font>, are " +
            "written without horiz-adv-x and dropped on reading; the glyph I_I.salt_v of U+E202 is written under " +
            'unicode="&#xe201;&#xe201;", the code points of its name as a ligature, so U+E202 is not written at all.',
    },
    {
        fixtures: [PACIFICO],
        toExtensions: [Extension.SVG],
        resultFacts: (sourceFacts: FontFacts): FontFacts => {
            const withZeroWidths = changes.withZeroWidthsAs(sourceFacts, SVG_OMITTED_WIDTH);
            const withNamedGlyphs = changes.withCodePoints(
                withZeroWidths,
                new Map([
                    [0x013f, [673]],
                    [0x0140, [363]],
                    [0x0237, [254]],
                    [0x0302, [SVG_OMITTED_WIDTH]],
                    [0x0307, [SVG_OMITTED_WIDTH]],
                    [0x030a, [SVG_OMITTED_WIDTH]],
                    [0x0327, [SVG_OMITTED_WIDTH]],
                    [0x2074, [450]],
                    [0xfb00, [684]],
                    [0xfb01, [633]],
                    [0xfb02, [688]],
                ]),
            );

            return { ...withNamedGlyphs, glyphCount: sourceFacts.glyphCount - 1 };
        },
        reason:
            "Defects of reading SVG (issue #913). The subset of Google Fonts keeps glyphs it does not encode, and " +
            "fontforge gives each of them the code point of its name (Ldot U+013F, fi U+FB01 and the rest listed); " +
            "the zero-width ones among them and the zero widths of the font come back as 1000. The empty NULL glyph " +
            "is dropped, one glyph less, which takes back the one the <missing-glyph> adds.",
    },
];
