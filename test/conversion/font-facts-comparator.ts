import type { FactName, FontFacts } from "test/conversion/font-facts-reader.types";

type ScalarFactName = Exclude<keyof FontFacts, "advanceWidths">;

// A record rather than a list: a fact added to FontFacts and left out here is a type error, not a
// fact that is read and never compared.
const SCALAR_FACTS: Record<ScalarFactName, true> = {
    glyphCount: true,
    familyName: true,
    unitsPerEm: true,
    ascent: true,
    descent: true,
};

export type FactDifference = {
    fact: FactName;
    // What differs, for the message of a failed check.
    details: string;
};

export class FontFactsComparator {
    public compare(expectedFacts: FontFacts, resultFacts: FontFacts): Array<FactDifference> {
        const differences: Array<FactDifference> = [];

        for (const fact of Object.keys(SCALAR_FACTS) as Array<ScalarFactName>) {
            if (expectedFacts[fact] !== resultFacts[fact]) {
                differences.push({ fact: fact, details: `expected ${expectedFacts[fact]}, got ${resultFacts[fact]}` });
            }
        }

        const missingCodePoints = this.codePointsOnlyIn(expectedFacts.advanceWidths, resultFacts.advanceWidths);
        const unexpectedCodePoints = this.codePointsOnlyIn(resultFacts.advanceWidths, expectedFacts.advanceWidths);

        if (missingCodePoints.length > 0 || unexpectedCodePoints.length > 0) {
            differences.push({
                fact: "codePoints",
                details: `missing ${this.formatCodePoints(missingCodePoints)}, unexpected ${this.formatCodePoints(unexpectedCodePoints)}`,
            });
        }

        // A code point present on one side only is already a codePoints difference.
        const changedWidths: Array<string> = [];

        for (const [codePoint, expectedWidths] of expectedFacts.advanceWidths) {
            const resultWidths = resultFacts.advanceWidths.get(codePoint);

            if (resultWidths !== undefined && !this.areSameWidths(expectedWidths, resultWidths)) {
                changedWidths.push(
                    `${this.formatCodePoints([codePoint])} expected ${expectedWidths.join("/")}, got ${resultWidths.join("/")}`,
                );
            }
        }

        if (changedWidths.length > 0) {
            differences.push({ fact: "advanceWidths", details: changedWidths.join(", ") });
        }

        return differences;
    }

    private areSameWidths(widths: Array<number>, otherWidths: Array<number>): boolean {
        if (widths.length !== otherWidths.length) {
            return false;
        }

        return widths.every((width, index) => width === otherWidths[index]);
    }

    private codePointsOnlyIn(widths: Map<number, Array<number>>, otherWidths: Map<number, Array<number>>): Array<number> {
        return Array.from(widths.keys()).filter((codePoint) => !otherWidths.has(codePoint));
    }

    private formatCodePoints(codePoints: Array<number>): string {
        if (codePoints.length === 0) {
            return "none";
        }

        return codePoints.map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
    }
}
