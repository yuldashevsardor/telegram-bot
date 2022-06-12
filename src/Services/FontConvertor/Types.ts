export enum Extension {
    WOFF = "woff",
    WOFF2 = "woff2",
    OTF = "otf",
    TTF = "ttf",
    EOT = "eot",
    SVG = "svg",
}

export const mimeTypesByExtension = {
    [Extension.EOT]: ["application/vnd.ms-fontobject"],
    [Extension.OTF]: ["application/x-font-opentype", "font/opentype", " application/font-sfnt", "font/otf"],
    [Extension.TTF]: ["application/x-font-ttf", "application/x-font-truetype", " application/font-sfnt", "font/ttf"],
    [Extension.WOFF]: ["application/font-woff", "font/woff"],
    [Extension.WOFF2]: ["application/font-woff2", "font/woff2"],
    [Extension.SVG]: ["image/svg+xml"],
};

export type ConvertParams = {
    originPath: string;
    extension: Extension;
};
