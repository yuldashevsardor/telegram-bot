import { RuntimeError } from "app/shared/errors";
import type { Encoding, FontRule } from "app/font-convertor/svg-validator/svg-font-validator.types";

// The root and an attribute value come from the user's file and may be of any length, while the
// error carries them into the log.
const MAX_QUOTED_LENGTH = 64;

/**
 * Cuts a quote from the file to `MAX_QUOTED_LENGTH` UTF-16 units. A surrogate pair cut in half
 * becomes U+FFFD: a lone surrogate is not valid UTF-8 on the way out.
 */
function clip(text: string): string {
    return text.length > MAX_QUOTED_LENGTH ? `${text.slice(0, MAX_QUOTED_LENGTH).toWellFormed()}…` : text;
}

/**
 * The file is not a valid SVG font. `SvgFontValidator` answers with one of the subclasses, and a
 * caller tells them apart by `instanceof`.
 */
export class InvalidSvgFont extends RuntimeError {}

export class NotXml extends InvalidSvgFont {
    public static byEncoding(encoding: Encoding, cause: Error): NotXml {
        return new NotXml(`File is not XML: its bytes are not valid ${encoding}.`, {
            encoding: encoding,
            cause: cause,
        });
    }

    public static byParser(cause: Error): NotXml {
        return new NotXml(`File is not XML: ${cause.message}`, cause);
    }
}

export class NotSvg extends InvalidSvgFont {
    public static byRoot(root: string, expected: string): NotSvg {
        const quoted = clip(root);

        return new NotSvg(`File is not SVG: the root element is ${quoted}, expected ${expected}.`, {
            root: quoted,
        });
    }
}

export class NoFont extends InvalidSvgFont {
    public static inDocument(): NoFont {
        return new NoFont("SVG has no font element in the SVG namespace.");
    }
}

export class BrokenFont extends InvalidSvgFont {
    public static byRule(rule: FontRule, element: string, line: number, attribute?: [string, string]): BrokenFont {
        const value = attribute === undefined ? undefined : clip(attribute[1]);
        const where = attribute === undefined ? `<${element}>` : `<${element}> with ${attribute[0]}=${JSON.stringify(value)}`;

        return new BrokenFont(`SVG font breaks a rule: ${rule}. At line ${line}: ${where}.`, {
            rule: rule,
            element: element,
            line: line,
            attribute: attribute?.[0],
            value: value,
        });
    }
}
