/**
 * Where a table lies in the file, as its directory record declares it. The tag is read as four
 * Latin-1 characters, so comparing two tags as strings compares them as the unsigned numbers of
 * their bytes.
 */
export type SfntTableRecord = {
    tag: string;
    offset: number;
    length: number;
};
