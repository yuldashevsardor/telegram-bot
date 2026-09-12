export enum Extension {
    WOFF = "woff",
    WOFF2 = "woff2",
    OTF = "otf",
    TTF = "ttf",
    EOT = "eot",
    SVG = "svg",
}

export type ConvertParams = {
    originPath: string;
    extension: Extension;
};

export type FontConvertorSettings = {
    tempDir: string;
};
