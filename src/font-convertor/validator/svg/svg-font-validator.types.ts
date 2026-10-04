/**
 * The encodings a file is read in: UTF-8, or UTF-16 of either byte order with a BOM. The values are
 * `TextDecoder` labels.
 */
export type Encoding = "utf-8" | "utf-16le" | "utf-16be";

/**
 * A rule a font, or the document around it, breaks. The text names the rule and where it comes
 * from: a section of SVG 1.1 Second Edition, or ours, where fontforge asks more than the
 * specification.
 */
export enum FontRule {
    AdvanceRequired = "font has horiz-adv-x (SVG 1.1, Appendix A.3.39)",
    Number = "a numeric attribute is a <number> (SVG 1.1, §4.2)",
    NonNegativeAdvance = "horiz-adv-x is not negative (SVG 1.1, §20.3, §20.4)",
    AdvanceRange = "horiz-adv-x and vert-adv-y are 0 to 32767 (ours: fontforge keeps an advance in a signed 16-bit field)",
    FontFaceRequired = "font has a font-face child (SVG 1.1, §20.3)",
    UnitsPerEmRequired = "font-face has units-per-em (ours: fontforge does not open a font without it)",
    PositiveUnitsPerEm = "units-per-em is positive (SVG 1.1, §20.8.3)",
    UnitsPerEmRange = "units-per-em is 16 to 16384 (ours: unitsPerEm of the OpenType head table)",
    FontFaceMetricRange = "ascent and descent of font-face are -32767 to 32767 (ours: fontforge writes them into signed 16-bit fields)",
    PathData = "d of a glyph or missing-glyph is path data (SVG 1.1, §8.3.9, §20.4, §20.5)",
    OutlineRange = "the points of d of a glyph or missing-glyph, and the shifts between neighbouring points, are within 32767 (ours: the converted font stores them in signed 16-bit fields)",
    GlyphRequired = "font has a glyph child (ours: fontforge turns a font without glyphs into an empty one)",
    SingleFont = "the document has one font element (ours: fontforge converts the first of several and drops the rest)",
    SvgNamespaceOnly = "the name of a font node is given only to an element in the SVG namespace (ours: fontforge reads a node of that name in any namespace, and a processing instruction by its target)",
    UnprefixedAttribute = "a font node has no prefixed attribute (ours: fontforge reads the first attribute of a local name, in any namespace)",
    ChildlessGlyph = "glyph and missing-glyph have no child elements or processing instructions (ours: fontforge draws a glyph without d from its children as any SVG, and drops them next to d)",
    KerningRequired = "hkern and vkern have k (SVG 1.1, §20.7)",
    KerningRange = "k of hkern and vkern is -32767 to 32767 (ours: fontforge keeps the negated k in a signed 16-bit field)",
    KernedGlyphRequired = "hkern and vkern name both glyphs of the pair, by u1 or g1 and by u2 or g2 (SVG 1.1, §20.7)",
    SingleKernedCharacter = "u1 and u2 of hkern and vkern are one character each (ours: fontforge reads them as a string of characters, not the list of §20.7)",
    NoInternalSubset = "the DOCTYPE has no internal subset (ours: fontforge takes attribute defaults from it, which the validator does not read)",
}

/**
 * The elements whose attributes of type <number> `NUMERIC_ATTRIBUTES` lists for `checkMetrics()`;
 * `k` of a kerning pair is checked apart from them.
 */
export type NumericElement = "font" | "glyph" | "missing-glyph";

/**
 * The range a number must lie in, both ends included.
 */
export type NumberRange = {
    min: number;
    max: number;
};

/**
 * The elements of a kerning pair (§20.7).
 */
export type KernElement = "hkern" | "vkern";

/**
 * An element the scan has opened and not closed yet.
 */
export type OpenElement = {
    /** The local name of an element in the SVG namespace, `undefined` for any other. */
    name: string | undefined;
    /** The line of the start tag. */
    line: number;
    /** Whether this is a `glyph` or `missing-glyph` the rules check: a direct child of `font`. */
    isGlyph: boolean;
    /** Whether a `font` has a `font-face` child; tracked for a `font` only. */
    hasFontFace: boolean;
    /** Whether a `font` has a `glyph` child; tracked for a `font` only. */
    hasGlyph: boolean;
};

/**
 * A broken rule the pass met: what `BrokenFont` is built from once the pass is over.
 */
export type Violation = {
    rule: FontRule;
    /** The local name of an element, or as the answer quotes it a processing instruction, `?target?`, or the DOCTYPE, `!DOCTYPE`. */
    element: string;
    /** The namespace of an element outside the SVG one, `undefined` otherwise: the answer then quotes the element in Clark notation. */
    namespace: string | undefined;
    line: number;
    /**
     * The attribute that breaks the rule, as a name and a value; `undefined` for a rule of the
     * element itself. A prefixed name is the qualified one from the file.
     */
    attribute: [string, string] | undefined;
};

/**
 * What one pass over the document learned. The answers are given after the pass, because a
 * document that is not XML is "not XML" even when its well-formed head already broke a font rule.
 */
export type Scan = {
    /** Whether the DOCTYPE is the SVG 1.1 one: it binds the default namespace and `xlink`, as its DTD fixes them. */
    svg11Doctype: boolean;
    /** The root element in Clark notation, `{namespace}local`. */
    root: string | undefined;
    /** Whether a `font` in the SVG namespace was met: the font the rules check. */
    hasFont: boolean;
    /** The first broken rule the pass met. */
    violation: Violation | undefined;
    open: Array<OpenElement>;
};
