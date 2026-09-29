/**
 * What a command takes in one argument: a signed number, a number without a sign (the radii of an
 * arc) or a flag, a single `0` or `1` (the arc flags).
 */
enum Parameter {
    Signed,
    NonNegative,
    Flag,
}

const PAIR = [Parameter.Signed, Parameter.Signed];
// The grammar joins the rotation and the first flag by comma-wsp, not comma-wsp?. A flag digit right
// after the rotation is read into the rotation, so the difference never decides anything, and
// encoding it would leave a mutant that no input kills.
const ARC = [
    Parameter.NonNegative,
    Parameter.NonNegative,
    Parameter.Signed,
    Parameter.Flag,
    Parameter.Flag,
    Parameter.Signed,
    Parameter.Signed,
];

// The arguments of one repetition of each command. Closepath takes none and does not repeat.
const COMMANDS: ReadonlyMap<string, ReadonlyArray<Parameter>> = new Map([
    ["M", PAIR],
    ["m", PAIR],
    ["Z", []],
    ["z", []],
    ["L", PAIR],
    ["l", PAIR],
    ["H", [Parameter.Signed]],
    ["h", [Parameter.Signed]],
    ["V", [Parameter.Signed]],
    ["v", [Parameter.Signed]],
    ["C", [...PAIR, ...PAIR, ...PAIR]],
    ["c", [...PAIR, ...PAIR, ...PAIR]],
    ["S", [...PAIR, ...PAIR]],
    ["s", [...PAIR, ...PAIR]],
    ["Q", [...PAIR, ...PAIR]],
    ["q", [...PAIR, ...PAIR]],
    ["T", PAIR],
    ["t", PAIR],
    ["A", ARC],
    ["a", ARC],
]);

const MOVETO = ["M", "m"];
const WHITESPACE = [" ", "\t", "\r", "\n"];
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const SIGNS = ["+", "-"];
const EXPONENTS = ["e", "E"];
const FLAGS = ["0", "1"];

/**
 * Reads the text once from the start. A number is read greedily: §8.3.9 says the processing of the
 * BNF "must consume as much of a given BNF production as possible", so "M 100-200" is 100 and -200,
 * and "M 0.6.5" is 0.6 and .5.
 */
class PathDataReader {
    private position = 0;

    public constructor(private readonly text: string) {}

    public readPath(): boolean {
        this.skipAll(WHITESPACE);

        // "The BNF allows the path 'd' attribute to be empty."
        if (this.isAtEnd()) {
            return true;
        }

        if (!MOVETO.includes(this.current())) {
            return false;
        }

        // Commands are separated by whitespace alone.
        while (!this.isAtEnd()) {
            if (!this.readCommand()) {
                return false;
            }

            this.skipAll(WHITESPACE);
        }

        return true;
    }

    private readCommand(): boolean {
        const parameters = COMMANDS.get(this.current());

        if (parameters === undefined) {
            return false;
        }

        this.position += 1;

        if (parameters.length === 0) {
            return true;
        }

        this.skipAll(WHITESPACE);

        do {
            if (!this.readArguments(parameters)) {
                return false;
            }
        } while (this.skipToNextArguments());

        return true;
    }

    /**
     * Skips the separator after the arguments of a command and says whether more arguments of it
     * follow. A comma separates arguments alone, so more of them must follow it; without one they
     * end at the next command or the end.
     */
    private skipToNextArguments(): boolean {
        if (this.skipSeparator()) {
            return true;
        }

        return !this.isAtEnd() && !COMMANDS.has(this.current());
    }

    private readArguments(parameters: ReadonlyArray<Parameter>): boolean {
        for (const [index, parameter] of parameters.entries()) {
            if (index > 0) {
                this.skipSeparator();
            }

            if (!this.readArgument(parameter)) {
                return false;
            }
        }

        return true;
    }

    private readArgument(parameter: Parameter): boolean {
        switch (parameter) {
            case Parameter.Signed:
                this.skipOne(SIGNS);

                return this.readUnsignedNumber();
            case Parameter.NonNegative:
                return this.readUnsignedNumber();
            case Parameter.Flag:
                return this.skipOne(FLAGS);
        }
    }

    /**
     * Reads `digits`, `digits.`, `.digits` or `digits.digits`, with an optional exponent.
     */
    private readUnsignedNumber(): boolean {
        const integerDigitCount = this.skipAll(DIGITS);
        let fractionDigitCount = 0;

        if (this.skipOne(["."])) {
            fractionDigitCount = this.skipAll(DIGITS);
        }

        if (integerDigitCount + fractionDigitCount === 0) {
            return false;
        }

        // An `e` that starts no exponent could only start the next token, and no command is `e`.
        if (!this.skipOne(EXPONENTS)) {
            return true;
        }

        this.skipOne(SIGNS);

        return this.skipAll(DIGITS) > 0;
    }

    /**
     * Skips comma-wsp?: whitespace, at most one comma, whitespace. Says whether there was a comma.
     */
    private skipSeparator(): boolean {
        this.skipAll(WHITESPACE);
        const hasComma = this.skipOne([","]);
        this.skipAll(WHITESPACE);

        return hasComma;
    }

    /**
     * Skips the characters from `characters` in a row and says how many there were.
     */
    private skipAll(characters: ReadonlyArray<string>): number {
        const start = this.position;

        while (this.skipOne(characters)) {
            // The condition moves the position.
        }

        return this.position - start;
    }

    // Past the end `current()` is an empty string, which no list holds.
    private skipOne(characters: ReadonlyArray<string>): boolean {
        if (!characters.includes(this.current())) {
            return false;
        }

        this.position += 1;

        return true;
    }

    private current(): string {
        return this.text.charAt(this.position);
    }

    private isAtEnd(): boolean {
        return this.position >= this.text.length;
    }
}

/**
 * Says whether `text` is path data by the grammar of SVG 1.1 Second Edition, §8.3.9 "The grammar for
 * path data". The `d` of a glyph takes the same syntax (§20.4).
 */
export function isPathData(text: string): boolean {
    return new PathDataReader(text).readPath();
}
