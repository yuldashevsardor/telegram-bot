import { expect } from "chai";
import { isOutlineWithinRange } from "app/font-convertor/validator/svg/outline-range";
import { readPathData } from "app/font-convertor/validator/svg/path-data";
import type { PathSegment } from "app/font-convertor/validator/svg/path-data";

function isWithinRange(pathData: string): boolean {
    const segments = readPathData(pathData);

    expect(segments, pathData).to.not.equal(undefined);

    return isOutlineWithinRange(segments as ReadonlyArray<PathSegment>);
}

describe("isOutlineWithinRange", function () {
    describe("accepts", function () {
        const cases: Record<string, Array<string>> = {
            "an empty outline and a lone moveto": ["", "M0 0", "M-32767 32767Z"],
            "a glyph of the usual size": ["M937 272h-481l-84 -272h-375l534 1456h330l538 -1456h-377zM540 543h313l-157 505z"],
            "points on the edge of the range": [
                "M0 0L32767 0L32767 700L0 700Z",
                "M-32767 -32767L0 -32767L0 0Z",
                "M0 0L32767 32767L0 32767Z",
            ],
            "a shift on the edge of the range": ["M-16384 0H16383H-1V700Z", "M0 -32767V0H700Z"],
            "a relative outline that stays within the range": ["m100 100l30000 0l0 700l-30000 0z", "M0 0h32767v-700h-32767z"],
            "a second contour that starts near the last point of the first": ["M-30000 0H0V700ZM-30000 1400H0V2100Z"],
            "a pair after a moveto, read as a lineto": ["M0 0 20000 0 20000 700", "m0 0 20000 0 -20000 700"],
            "a cubic curve and a smooth one after it": [
                "M0 0C0 10000 10000 20000 20000 20000S30000 10000 20000 0Z",
                "M0 0S10000 10000 20000 0Z",
            ],
            "a quadratic curve and a smooth one after it": ["M0 0Q10000 10000 20000 0T30000 0Z", "M0 0T20000 0Z"],
            "a quadratic curve after a cubic one, with the controls apart": ["M0 0C0 10000 10000 10000 10000 0Q-20000 0 0 0Z"],
            "an arc of the radius on the edge of the range": ["M0 0A32767 32767 0 0 1 700 0Z", "M0 0a32767 1 0 1 0 700 700Z"],
            "an arc with a zero radius, which is a straight line, and the other radius past the range": [
                "M0 0A0 40000 0 0 1 700 0Z",
                "M0 0a40000 0 0 0 1 700 0z",
            ],
            "a point after a closepath, which starts at the point the closepath left": ["M-10000 0H0V700ZL10000 0H20000Z"],
            "a smooth cubic curve right after a closepath, which leaves no control point to reflect": [
                "M30000 0C0 0 0 0 0 0ZS30000 0 30000 0",
            ],
            "a smooth quadratic curve right after a closepath, which leaves no control point to reflect": ["M30000 0Q0 0 0 0ZT30000 0"],
            "a smooth cubic curve right after a relative moveto, which leaves no control point to reflect": [
                "M0 0C0 0 0 0 0 0m30000 0S30000 0 30000 0",
            ],
            "a smooth quadratic curve right after a relative moveto, which leaves no control point to reflect": [
                "M0 0Q0 0 0 0m30000 0T30000 0",
            ],
        };

        for (const [behaviour, values] of Object.entries(cases)) {
            it(behaviour, function () {
                for (const value of values) {
                    expect(isWithinRange(value), value).to.equal(true);
                }
            });
        }
    });

    describe("rejects", function () {
        const cases: Record<string, Array<string>> = {
            "a point just past the range": ["M0 0L32768 0L32768 700L0 700Z", "M0 0L-32768 0L-32768 700Z", "M0 0V32768H700Z"],
            "a point far past the range": ["M0 0L70000 0L70000 700L0 700Z", "M0 0L1e999 0L0 700Z", "M1e999 0L0 700Z"],
            "a first point reached from the origin past the range": ["M32768 0L32768 700L32769 700Z", "M-60000 0l10 0l0 700z"],
            "a point past the range reached through relative commands in range": [
                "M30000 0l30000 0l0 700l-30000 0z",
                "M0 0h20000h20000v700Z",
                "m0 0 20000 0 20000 0 0 700",
            ],
            "a shift past the range between points in range": [
                "M-30000 0L30000 0L30000 700Z",
                "M0 -30000V30000H700Z",
                "M0 0H32767V32767H-1Z",
            ],
            "a closing line past the range, which a CFF contour draws": ["M-20000 0H0H20000Z", "M0 -20000V0V20000Z"],
            "a moveto past the range from the start of the contour before, which a CFF contour shifts from": [
                "M-25000 0H0V700ZM10000 0H11000V700Z",
            ],
            "a moveto past the range from the last point of the contour before, which a TrueType contour shifts from": [
                "M0 0H25000V700ZM-10000 0H-11000V700Z",
            ],
            "a line after a closepath that reaches past the range from the point the closepath left, not from the last point": [
                "M-20000 0H0V700ZL20000 0Z",
            ],
            "a control point of a cubic curve past the range": [
                "M0 0C40000 0 0 700 700 700Z",
                "M0 0C0 0 40000 700 700 700Z",
                "M20000 0C34000 0 20000 700 20000 700Z",
            ],
            "a relative cubic curve with its end past the range": ["M0 0c0 0 0 0 40000 0Z"],
            "a control point of a smooth cubic curve reflected past the range": [
                "M0 0C0 -10000 0 -10000 0 20000S0 0 0 0Z",
                "M0 0c0 -10000 0 -10000 0 20000s0 0 0 0z",
            ],
            "a control point of a quadratic curve past the range": ["M0 0Q40000 0 700 700Z", "M0 0q0 40000 700 700z"],
            "the controls of two quadratic curves in a row apart past the range": [
                "M2933 -287q27724 21719 2967 3562t-4115 424Z",
                "M0 0Q20000 0 0 0Q-20000 0 0 0Z",
            ],
            "a control point of a smooth quadratic curve reflected past the range": ["M0 0Q0 -10000 0 20000T0 0Z"],
            "an arc with a radius past the range": [
                "M0 0A32768 100 0 0 1 700 0Z",
                "M0 0a100 32768 0 0 1 700 0z",
                "M0 0A1e999 1 0 0 1 700 0Z",
            ],
            "an arc with its end past the range": ["M0 0A100 100 0 0 1 40000 0Z", "M0 0a100 100 0 0 1 0 -40000z"],
            "an arc right after a closepath, which starts at the point the closepath left": ["M-20000 0H0V700ZA100 100 0 0 1 20000 0Z"],
            "an arc right after a relative moveto, which adds to the point the moveto reached": ["m20000 0a100 100 0 0 1 20000 0z"],
        };

        for (const [behaviour, values] of Object.entries(cases)) {
            it(behaviour, function () {
                for (const value of values) {
                    expect(isWithinRange(value), value).to.equal(false);
                }
            });
        }
    });
});
