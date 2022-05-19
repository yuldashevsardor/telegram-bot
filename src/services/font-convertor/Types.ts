export enum Format {
    WOFF = "woff",
    WOFF2 = "woff2",
    OTF = "OTF",
    TTF = "TTF",
    EOT = "EOT",
}

export type ConvertParams = {
    path: string;
    format: Format;
};

export type ComposerConvertCommandParams = {
    src: string;
    format: Format;
};
