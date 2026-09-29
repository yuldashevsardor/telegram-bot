import type { Extension } from "app/font-convertor/font-convertor.types";

/**
 * A format recognised by its signature. SVG has none: its format is confirmed by `SvgFontValidator`.
 */
export type SignedExtension = Exclude<Extension, Extension.SVG>;

/**
 * A format signature: the bytes the domain expects at a fixed offset from the start of the file.
 */
export type Signature = {
    offset: number;
    bytes: Array<number>;
};
