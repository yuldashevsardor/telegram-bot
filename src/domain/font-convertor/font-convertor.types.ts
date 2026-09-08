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

/**
 * Что домен пропускает перед сигнатурой, прежде чем сверять байты.
 */
export enum Prefix {
    /** Ничего: сигнатура лежит по жёсткому смещению от начала файла. */
    None = "none",
    /** UTF-8 BOM, если он есть. */
    Bom = "bom",
    /** UTF-8 BOM и ведущие пробельные символы. */
    Indent = "indent",
}

/**
 * Сигнатура формата: байты, которые домен ждёт по смещению от конца префикса.
 */
export type Signature = {
    offset: number;
    bytes: Array<number>;
    prefix?: Prefix;
};
