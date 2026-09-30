import type { Extension } from "app/font-convertor/font-convertor.types";

/**
 * A format recognised by its signature. SVG has none: its format is confirmed by `SvgFontValidator`.
 * TTF and OTF have one, the sfnt version, and WOFF has one too, but `SfntFontValidator` and
 * `WoffFontValidator` check each together with the rest of the file.
 */
export type SignedExtension = Exclude<Extension, Extension.SVG | Extension.TTF | Extension.OTF | Extension.WOFF>;

/**
 * A format signature: the bytes the domain expects at a fixed offset from the start of the file.
 */
export type Signature = {
    offset: number;
    bytes: Array<number>;
};
