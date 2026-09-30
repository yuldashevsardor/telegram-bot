import type { Extension } from "app/font-convertor/font-convertor.types";

/**
 * A format recognised by its signature. SVG has none: its format is confirmed by `SvgFontValidator`.
 * WOFF has one, but `WoffFontValidator` checks it together with the rest of the WOFF file.
 */
export type SignedExtension = Exclude<Extension, Extension.SVG | Extension.WOFF>;

/**
 * A format signature: the bytes the domain expects at a fixed offset from the start of the file.
 */
export type Signature = {
    offset: number;
    bytes: Array<number>;
};
