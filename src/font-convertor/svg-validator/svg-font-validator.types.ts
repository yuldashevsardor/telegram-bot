import type { BrokenFont } from "app/font-convertor/svg-validator/svg-font-validator.errors";

/**
 * The encodings a file is read in: UTF-8, or UTF-16 of either byte order with a BOM. The values are
 * `TextDecoder` labels.
 */
export type Encoding = "utf-8" | "utf-16le" | "utf-16be";

/**
 * A rule a font breaks. The text names the rule and where it comes from: a section of SVG 1.1 Second
 * Edition, or ours, where fontforge asks more than the specification.
 */
export enum FontRule {
    AdvanceRequired = "font has horiz-adv-x (SVG 1.1, Appendix A.3.39)",
    Number = "a numeric attribute is a <number> (SVG 1.1, §4.2)",
    NonNegativeAdvance = "horiz-adv-x is not negative (SVG 1.1, §20.3, §20.4)",
    FontFaceRequired = "font has a font-face child (SVG 1.1, §20.3)",
    UnitsPerEmRequired = "font-face has units-per-em (ours: fontforge does not open a font without it)",
    PositiveUnitsPerEm = "units-per-em is positive (SVG 1.1, §20.8.3)",
    GlyphRequired = "font has a glyph child (ours: fontforge turns a font without glyphs into an empty one)",
}

/**
 * An element the scan has opened and not closed yet.
 */
export type OpenElement = {
    /** The local name of an element in the SVG namespace, `undefined` for any other. */
    name: string | undefined;
    /** The line of the start tag. */
    line: number;
    /** Whether a `font` has a `font-face` child; tracked for a `font` only. */
    hasFontFace: boolean;
    /** Whether a `font` has a `glyph` child; tracked for a `font` only. */
    hasGlyph: boolean;
};

/**
 * What one pass over the document learned. The answers are given after the pass, because a
 * document that is not XML is "not XML" even when its well-formed head already broke a font rule.
 */
export type Scan = {
    /** Whether the DOCTYPE is the SVG 1.1 one: it binds unprefixed names to the SVG namespace. */
    svg11Doctype: boolean;
    /** The root element in Clark notation, `{namespace}local`. */
    root: string | undefined;
    hasFont: boolean;
    /** The first broken rule the pass met. */
    violation: BrokenFont | undefined;
    open: Array<OpenElement>;
};
