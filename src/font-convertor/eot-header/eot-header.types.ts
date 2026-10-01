/**
 * A block of the variable part of the header: a Padding (u16), the size of the block (u16), then
 * the block itself. `offset` and `sizeBytes` are where the block lies as its size declares it, which
 * may run past the end of the file: the parse reads the fields it needs and leaves the extent of a
 * block to its readers.
 */
export type EotBlock = {
    padding: number;
    offset: number;
    sizeBytes: number;
};

/**
 * The names of the header and, from version 0x00020001, RootString. The padding of `familyName`
 * is Padding1, the last field of the fixed part.
 */
export type EotNames = {
    familyName: EotBlock;
    styleName: EotBlock;
    versionName: EotBlock;
    fullName: EotBlock;
    rootString: EotBlock | undefined;
    /**
     * The offset right after the last block, possibly past the end of the file.
     */
    endOffset: number;
};

/**
 * The fields version 0x00020002 adds after RootString. The padding of `signature` is Padding6.
 */
export type EotTail = {
    rootStringCheckSum: number;
    eudcCodePage: number;
    signature: EotBlock;
    eudcFlags: number;
    eudcFontOffset: number;
    eudcFontSizeBytes: number;
    /**
     * The offset right after EUDCFontData, possibly past the end of the file.
     */
    endOffset: number;
};
