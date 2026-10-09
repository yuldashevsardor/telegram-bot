import { RuntimeError } from "app/shared/errors";

/**
 * An SVG font that does not read as one, though it has passed `SvgFontValidator`: the validator and
 * the preparer read the file apart from each other.
 */
export class UnpreparableSvgFont extends RuntimeError {
    // The TypeError of TextDecoder says nothing of the file, so it is kept as the cause.
    public static byEncoding(sourcePath: string, cause: Error): UnpreparableSvgFont {
        return new UnpreparableSvgFont("The SVG font cannot be prepared for the engine: its bytes are not in its encoding.", {
            path: sourcePath,
            cause: cause,
        });
    }

    // The saxes error is not kept: its message quotes names from the file uncut, and the log would
    // print them. SvgFontValidator.validate() of the same file names what is wrong.
    public static byParser(sourcePath: string): UnpreparableSvgFont {
        return new UnpreparableSvgFont("The SVG font cannot be prepared for the engine: it is not XML.", { path: sourcePath });
    }
}
