/**
 * One of the seven substreams of a transformed glyf (§5.1), read from the start: `offset` is where
 * the next glyph record takes its bytes from.
 */
export type Substream = {
    /** How the standard and a message name it: `nPointsStream`. */
    name: string;
    bytes: Uint8Array;
    offset: number;
};

/**
 * A point of a simple glyph, its coordinates the sum of the deltas before it (§5.2).
 */
export type Point = {
    x: number;
    y: number;
    isOnCurve: boolean;
};

/**
 * A transformed hmtx (§5.4) with hhea, whose numberOfHMetrics says how many advance widths it
 * holds; hhea is undefined when the font has none.
 */
export type TransformedHmtx = {
    bytes: Uint8Array;
    hhea: Uint8Array | undefined;
};

/**
 * A transformed hmtx that rule `TransformedHmtx` holds for, with its flags read: whether lsb[] and
 * leftSideBearing[] are in the table.
 */
export type RebuildableHmtx = {
    bytes: Uint8Array;
    numberOfHMetrics: number;
    hasLsb: boolean;
    hasLeftSideBearing: boolean;
};

/**
 * What `GlyfReconstructor` rebuilds: glyf and loca, and hmtx when it is transformed.
 */
export type ReconstructedTables = {
    glyf: Uint8Array;
    loca: Uint8Array;
    hmtx: Uint8Array | undefined;
};
