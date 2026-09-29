/**
 * Where a table lies in the file, as its directory record declares it.
 */
export type SfntTableRecord = {
    offset: number;
    length: number;
};
