/**
 * The sfnt fields EOT duplicates in its header.
 */
export type SfntMetadata = {
    panose: Uint8Array;
    italic: number;
    weight: number;
    fsType: number;
    unicodeRange: Array<number>;
    codePageRange: Array<number>;
    checkSumAdjustment: number;
    familyName: string;
    styleName: string;
    versionName: string;
    fullName: string;
};
