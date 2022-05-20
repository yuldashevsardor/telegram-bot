export enum Extension {
    WOFF = "woff",
    WOFF2 = "woff2",
    OTF = "otf",
    TTF = "ttf",
    EOT = "eot",
}

export const mimeTypesByExtension = {
    [Extension.WOFF]: ["application/font-woff", "font/woff"],
    [Extension.WOFF2]: ["application/font-woff2", "font/woff2"],
    [Extension.OTF]: ["application/x-font-opentype", "font/opentype", " application/font-sfnt", "font/otf"],
    [Extension.TTF]: ["application/x-font-ttf", "application/x-font-truetype", " application/font-sfnt", "font/ttf"],
    [Extension.EOT]: ["application/vnd.ms-fontobject"],
};

export type FontConvertorParams = {
    tempDir: string;
    pythonPath: string;
};

export type ConvertParams = {
    originPath: string;
    extension: Extension;
};
