import { RuntimeError } from "app/shared/errors";
import type { Encoding, FontRule } from "app/font-convertor/svg-validator/svg-font-validator.types";

// Text from the file may be of any length, while the error carries it into the log. A quote is
// cut to the first limit. A parser message is cut to the second: saxes quotes names from the file
// in it, and `checkEncoding` the declared encoding.
const MAX_QUOTED_LENGTH = 64;
const MAX_PARSER_MESSAGE_LENGTH = 200;

/**
 * Cuts `text` to `maxLength` UTF-16 units and puts `…` after the kept part as `show` renders it. A
 * surrogate pair cut in half becomes U+FFFD: a lone surrogate is not valid UTF-8 on the way out.
 */
function clip(text: string, maxLength: number, show = (shown: string): string => shown): string {
    return text.length > maxLength ? `${show(text.slice(0, maxLength).toWellFormed())}…` : show(text);
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

    /**
     * The saxes error is not kept as the cause: it carries nothing but its message, and the log
     * would print that message uncut.
     */
    public static byParser(error: Error): NotXml {
        return new NotXml(`File is not XML: ${clip(error.message, MAX_PARSER_MESSAGE_LENGTH)}`);
    }
}

export class NotSvg extends InvalidSvgFont {
    /**
     * `root` is in Clark notation, `{namespace}local`. An NCName holds no `}`, so the local name
     * follows the last one. Each part is cut on its own: a long namespace must not cut off the name.
     */
    public static byRoot(root: string, expected: string): NotSvg {
        const end = root.lastIndexOf("}") + 1;
        const quoted = `${clip(root.slice(0, end), MAX_QUOTED_LENGTH)}${clip(root.slice(end), MAX_QUOTED_LENGTH)}`;

        return new NotSvg(`File is not SVG: the root element is ${quoted}, expected ${expected}.`, {
            root: quoted,
            rootLength: root.length,
        });
    }
}

export class NoFont extends InvalidSvgFont {
    public static inDocument(): NoFont {
        return new NoFont("SVG has no font element in the SVG namespace.");
    }
}

export class BrokenFont extends InvalidSvgFont {
    /**
     * A cut value ends with `…` outside the quotes in the message; in the payload `valueLength`,
     * the length before the cut, tells it apart from a value that ends with `…` itself.
     */
    public static byRule(rule: FontRule, element: string, line: number, attribute?: [string, string]): BrokenFont {
        const at = `SVG font breaks a rule: ${rule}. At line ${line}: <${element}>`;

        if (attribute === undefined) {
            return new BrokenFont(`${at}.`, { rule: rule, element: element, line: line });
        }

        const [name, value] = attribute;

        return new BrokenFont(`${at} with ${name}=${clip(value, MAX_QUOTED_LENGTH, JSON.stringify)}.`, {
            rule: rule,
            element: element,
            line: line,
            attribute: name,
            value: clip(value, MAX_QUOTED_LENGTH),
            valueLength: value.length,
        });
    }
}
