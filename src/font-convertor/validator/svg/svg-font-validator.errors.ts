import { RuntimeError } from "app/shared/errors";
import type { Violation } from "app/font-convertor/validator/svg/svg-font-validator.types";
import type { Encoding } from "app/font-convertor/validator/svg/svg-text-codec";

// Text from the file may be of any length, while the error carries it into the log. A quote from
// it is cut on its own to the first limit: a name in Clark notation keeps that much of its
// namespace and as much of its local name, a prefixed attribute name that much of its prefix and
// as much of its local name. The messages of `NotSvg` and `BrokenFont` escape the element, the root
// and the value they keep as in a JSON string, which at most doubles it: of what the parser lets
// through as XML 1.0, it escapes only tab, LF, CR, `"` and `\`, each as two units. An attribute
// name is not escaped: a name holds none of them. A parser message is cut to the second limit:
// saxes quotes names from the file in it, and `checkEncoding` the declared encoding.
const MAX_QUOTED_LENGTH = 64;
const MAX_PARSER_MESSAGE_LENGTH = 200;

/**
 * The file is not a valid SVG font. `SvgFontValidator` answers with one of the subclasses, and a
 * caller tells them apart by `instanceof`. The payload of each names the file in `path`.
 */
export class InvalidSvgFont extends RuntimeError {
    /**
     * Keeps the first `maxLength` UTF-16 units of `text` and returns them with the mark of the cut:
     * `…` when anything was cut, or an empty string. The mark makes a cut piece one unit longer than
     * an uncut one can be: that, not the text, tells it from a piece that ends with `…` itself. A
     * surrogate pair cut in half becomes U+FFFD: a lone surrogate is not valid UTF-8 on the way out.
     */
    protected static clip(text: string, maxLength: number): [kept: string, mark: string] {
        return text.length > maxLength ? [text.slice(0, maxLength).toWellFormed(), "…"] : [text, ""];
    }

    /**
     * Quotes a name without a namespace or a prefix: a local name, or a processing instruction,
     * `?target?`. Of an instruction the target alone is cut, so that the quote keeps its `?…?`.
     */
    protected static clipName(name: string): string {
        // Stryker disable next-line MethodExpression: `endsWith` is equivalent: an XML name holds no `?`, so only an instruction, `?target?`, starts or ends with one
        if (name.startsWith("?")) {
            return `?${InvalidSvgFont.clip(name.slice(1, -1), MAX_QUOTED_LENGTH).join("")}?`;
        }

        return InvalidSvgFont.clip(name, MAX_QUOTED_LENGTH).join("");
    }

    /**
     * Quotes a name in Clark notation, `{namespace}local`. The namespace and the local name are cut
     * each on its own, so that a long namespace does not cut off the name, and the braces are kept,
     * so that the quote stays in Clark notation.
     */
    protected static clipClark(namespace: string, local: string): string {
        const [keptNamespace, namespaceMark] = InvalidSvgFont.clip(namespace, MAX_QUOTED_LENGTH);
        const [keptLocal, localMark] = InvalidSvgFont.clip(local, MAX_QUOTED_LENGTH);

        return `{${keptNamespace}${namespaceMark}}${keptLocal}${localMark}`;
    }

    /**
     * Escapes a quoted element for a message as in a JSON string, without the quotes, so that an
     * XML line end, LF or CR, in a namespace does not split the message. U+0085, U+2028 and U+2029
     * stay, as in the escaped value: XML 1.0 takes none of them for a line end. A name holds
     * nothing the escape touches, and a `}` in a namespace stays: a local name holds none and
     * follows the last one. The payload keeps the quote unescaped, so that there its length still
     * tells a cut piece.
     */
    protected static escapeForMessage(quoted: string): string {
        return JSON.stringify(quoted).slice(1, -1);
    }

    /**
     * Quotes an attribute name. The prefix and the local name of a prefixed one are cut each on its
     * own, so that a long prefix does not cut off the name. A prefix holds no `:`, so the local name
     * follows the first one.
     */
    protected static clipQualified(name: string): string {
        const colonIndex = name.indexOf(":");

        if (colonIndex === -1) {
            return InvalidSvgFont.clipName(name);
        }

        const [keptPrefix, prefixMark] = InvalidSvgFont.clip(name.slice(0, colonIndex), MAX_QUOTED_LENGTH);
        const [keptLocal, localMark] = InvalidSvgFont.clip(name.slice(colonIndex + 1), MAX_QUOTED_LENGTH);

        return `${keptPrefix}${prefixMark}:${keptLocal}${localMark}`;
    }
}

export class NotXml extends InvalidSvgFont {
    public static byEncoding(fontPath: string, encoding: Encoding, cause: Error): NotXml {
        return new NotXml(`File is not XML: its bytes are not valid ${encoding}.`, {
            path: fontPath,
            encoding: encoding,
            cause: cause,
        });
    }

    /**
     * The saxes error is not kept as the cause: it carries nothing but its message, and the log
     * would print that message uncut.
     */
    public static byParser(fontPath: string, error: Error): NotXml {
        return new NotXml(`File is not XML: ${InvalidSvgFont.clip(error.message, MAX_PARSER_MESSAGE_LENGTH).join("")}`, { path: fontPath });
    }
}

export class NotSvg extends InvalidSvgFont {
    /**
     * `root` is in Clark notation, `{namespace}local`. An NCName holds no `}`, so the local name
     * follows the last one. `rootLength`, the length of the whole root before the cut, does not say
     * which of its two pieces was cut.
     */
    public static byRoot(fontPath: string, root: string, expected: string): NotSvg {
        const end = root.lastIndexOf("}");
        const quoted = InvalidSvgFont.clipClark(root.slice(1, end), root.slice(end + 1));

        return new NotSvg(`File is not SVG: the root element is ${InvalidSvgFont.escapeForMessage(quoted)}, expected ${expected}.`, {
            path: fontPath,
            root: quoted,
            rootLength: root.length,
        });
    }
}

export class NoFont extends InvalidSvgFont {
    public static inDocument(fontPath: string): NoFont {
        return new NoFont("SVG has no font element in the SVG namespace.", { path: fontPath });
    }
}

export class BrokenFont extends InvalidSvgFont {
    /**
     * A cut value is told apart in the payload by its length and by `valueLength`, the length
     * before the cut. In the message the value is escaped by `JSON.stringify`, which can make it
     * longer, so there the mark stands outside the quotes.
     *
     * Of the element, the local name or the target of a glyph's child and the namespace of one
     * outside the SVG namespace come from the file; of the attribute name, the prefix and the local
     * name. Each is cut, and no length before the cut is kept for them, unlike for the value.
     */
    public static byRule(fontPath: string, violation: Violation): BrokenFont {
        const { rule, element, namespace, line, attribute } = violation;
        const quotedElement = namespace === undefined ? InvalidSvgFont.clipName(element) : InvalidSvgFont.clipClark(namespace, element);
        const at = `SVG font breaks a rule: ${rule}. At line ${line}: <${InvalidSvgFont.escapeForMessage(quotedElement)}>`;

        if (attribute === undefined) {
            return new BrokenFont(`${at}.`, { path: fontPath, rule: rule, element: quotedElement, line: line });
        }

        const [name, value] = attribute;
        const quotedName = InvalidSvgFont.clipQualified(name);
        const [kept, mark] = InvalidSvgFont.clip(value, MAX_QUOTED_LENGTH);

        return new BrokenFont(`${at} with ${quotedName}=${JSON.stringify(kept)}${mark}.`, {
            path: fontPath,
            rule: rule,
            element: quotedElement,
            line: line,
            attribute: quotedName,
            value: `${kept}${mark}`,
            valueLength: value.length,
        });
    }
}
