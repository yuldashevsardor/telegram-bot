// Why the validator of the format the extension names refused a file: the two rows of the error
// table of the customer journey (docs/product/cjm.md, step 5).
export enum FontRejection {
    // The file is not in the format at all: the extension lies.
    NotInFormat = "not-in-format",
    // The file is in the format and breaks its rules.
    Broken = "broken",
}
