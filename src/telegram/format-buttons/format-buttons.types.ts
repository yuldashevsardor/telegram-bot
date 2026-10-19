import type { Extension } from "app/font-convertor/font-convertor.types";

// What a press has done to the format of a button (docs/product/cjm.md, step 4).
export enum FormatMark {
    Sent = "sent",
    Failed = "failed",
}

// A press of a marked button: it converts nothing, and its answer names the mark.
export type MarkedPress = { mark: FormatMark; targetExtension: Extension };
