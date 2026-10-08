import type { FactName, FontFacts } from "test/conversion/font-facts-reader.types";

export type FactDifference = {
    fact: FactName;
    // What differs, for the message of a failed check.
    details: string;
};

export class FontFactsComparator {
    public compare(source: FontFacts, result: FontFacts): Array<FactDifference> {
        const differences: Array<FactDifference> = [];
        const scalarFacts = ["glyphCount", "familyName", "unitsPerEm", "ascent", "descent"] as const;

        for (const fact of scalarFacts) {
            if (source[fact] !== result[fact]) {
                differences.push({ fact: fact, details: `${source[fact]} -> ${result[fact]}` });
            }
        }

        const lostCodePoints = this.codePointsOnlyIn(source.advanceWidths, result.advanceWidths);
        const addedCodePoints = this.codePointsOnlyIn(result.advanceWidths, source.advanceWidths);

        if (lostCodePoints.length > 0 || addedCodePoints.length > 0) {
            differences.push({
                fact: "codePoints",
                details: `lost ${this.formatCodePoints(lostCodePoints)}, added ${this.formatCodePoints(addedCodePoints)}`,
            });
        }

        // A code point present on one side only is already a codePoints difference.
        const changedWidths: Array<string> = [];

        for (const [codePoint, sourceWidth] of source.advanceWidths) {
            const resultWidth = result.advanceWidths.get(codePoint);

            if (resultWidth !== undefined && resultWidth !== sourceWidth) {
                changedWidths.push(`${this.formatCodePoints([codePoint])} ${sourceWidth} -> ${resultWidth}`);
            }
        }

        if (changedWidths.length > 0) {
            differences.push({ fact: "advanceWidths", details: changedWidths.join(", ") });
        }

        return differences;
    }

    private codePointsOnlyIn(widths: Map<number, number>, otherWidths: Map<number, number>): Array<number> {
        return Array.from(widths.keys()).filter((codePoint) => !otherWidths.has(codePoint));
    }

    private formatCodePoints(codePoints: Array<number>): string {
        if (codePoints.length === 0) {
            return "none";
        }

        return codePoints.map((codePoint) => `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
    }
}
