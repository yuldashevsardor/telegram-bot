import { expect } from "chai";
import { readPathData } from "app/font-convertor/validator/svg/path-data";

describe("readPathData", function () {
    describe("accepts", function () {
        const cases: Record<string, Array<string>> = {
            "an empty value and whitespace alone": ["", " \t\r\n"],
            "every command, absolute and relative": [
                "M1 2",
                "m1 2",
                "M0 0Z",
                "M0 0z",
                "M0 0L1 2",
                "M0 0l1 2",
                "M0 0H3",
                "M0 0h3",
                "M0 0V4",
                "M0 0v4",
                "M0 0C1 2 3 4 5 6",
                "M0 0c1 2 3 4 5 6",
                "M0 0S1 2 3 4",
                "M0 0s1 2 3 4",
                "M0 0Q1 2 3 4",
                "M0 0q1 2 3 4",
                "M0 0T1 2",
                "M0 0t1 2",
                "M0 0A25 26 -30 0 1 50 -25",
                "M0 0a25 26 -30 0 1 50 -25",
            ],
            "the arguments of a command repeated after its letter": [
                "M0 0 10 10",
                "M0 0 L1 1 2 2 3 3",
                "M0 0 H1 2 3",
                "M0 0 C1 2 3 4 5 6 7 8 9 10 11 12",
                "M0 0 A1 1 0 0 0 5 5 2 2 0 1 1 6 6",
            ],
            "every separator between arguments": [
                "M1,2",
                "M1 ,2",
                "M1, 2",
                "M1 , 2",
                "M1\t2",
                "M1\r\n2",
                "M1-2",
                "M0 0 L1,2,3,4",
                "M0 0 L1 2 , 3 4",
            ],
            "whitespace around and between commands": [" \nM0 0 \t", "M0 0\nL1 1", "M0 0L1 1", "M0 0 z m1 1 z", "M0 0zM1 1"],
            "every form of a number": [
                "M0 1",
                "M23 45",
                "M67 89",
                "M+1 -1",
                "M1. .5",
                "M1.5 12.25",
                "M1e5 1E5",
                "M1e+5 1e-5",
                "M.5e5 1.e5",
                "M+.5 -5.",
            ],
            "numbers read greedily": ["M 100-200", "M 0.6.5", "M1e2-3", "M1.2.3"],
            "arc flags written without separators": ["M0 0 A25 25 -30 1150-25", "M0 0 a1 1 0 01.5.5", "M0 0 A25,25,-30,0,1,50,-25"],
        };

        for (const [behaviour, values] of Object.entries(cases)) {
            it(behaviour, function () {
                for (const value of values) {
                    expect(readPathData(value), JSON.stringify(value)).to.not.equal(undefined);
                }
            });
        }
    });

    describe("rejects", function () {
        const cases: Record<string, Array<string>> = {
            "path data that does not open with a moveto": ["L0 0", "0 0", "z", " l1 1", ",M0 0"],
            "a command with missing or incomplete arguments": ["M", "M0", "M0 0L", "M0 0 C1 2 3 4 5", "M0 0 L1 2 3", "M0 0 A1 1 0 0 0 5"],
            "arguments after closepath": ["M0 0z1 1", "M0 0 Z 1 1"],
            "a comma before the first argument, after the last one or doubled": [
                "M,0 0",
                "M0 0 L,1 1",
                "M0 0,",
                "M0 0, L1 1",
                "M0 0 z,m1 1",
                "M0,,0",
                "M0 0,,1 1",
            ],
            "whitespace other than space, tab, carriage return and line feed": ["M0\f0", "M0\u00a00", "\u00a0M0 0"],
            "an unknown letter": ["M0 0 B1 1", "M0 0 R1 1", "M0 0 e1 1"],
            "a malformed number": ["M. 0", "M1e 0", "M1e+ 0", "M1E- 0", "Me1 0", "M+-1 0", "M- 1 0", "M0 ..5"],
            "a signed radius": ["M0 0 A-1 1 0 0 0 5 5", "M0 0 A1 +1 0 0 0 5 5"],
            "a flag other than 0 or 1": ["M0 0 A1 1 0 2 0 5 5", "M0 0 A1 1 0 0 2 5 5", "M0 0 A1 1 0 -1 0 5 5", "M0 0 A1 1 0 .1 0 5 5"],
        };

        for (const [behaviour, values] of Object.entries(cases)) {
            it(behaviour, function () {
                for (const value of values) {
                    expect(readPathData(value), JSON.stringify(value)).to.equal(undefined);
                }
            });
        }
    });

    describe("gives the commands", function () {
        it("with their numbers, signs and exponents read as written", function () {
            expect(readPathData("M-1.5 +2 l.5e1,-3E-1")).to.deep.equal([
                { command: "M", values: [-1.5, 2] },
                { command: "l", values: [5, -0.3] },
            ]);
        });

        it("with the pairs after a moveto as linetos, relative after a relative moveto", function () {
            expect(readPathData("M1 2 3 4 5 6")).to.deep.equal([
                { command: "M", values: [1, 2] },
                { command: "L", values: [3, 4] },
                { command: "L", values: [5, 6] },
            ]);
            expect(readPathData("m1 2 3 4")).to.deep.equal([
                { command: "m", values: [1, 2] },
                { command: "l", values: [3, 4] },
            ]);
        });

        it("with the arguments after the letter of any other command repeated as the same command", function () {
            expect(readPathData("M0 0 H1 2 c1 2 3 4 5 6 7 8 9 10 11 12")).to.deep.equal([
                { command: "M", values: [0, 0] },
                { command: "H", values: [1] },
                { command: "H", values: [2] },
                { command: "c", values: [1, 2, 3, 4, 5, 6] },
                { command: "c", values: [7, 8, 9, 10, 11, 12] },
            ]);
        });

        it("with the flags of an arc as 0 or 1, glued to the next number", function () {
            expect(readPathData("M0 0a25 26 -30 0150 -25")).to.deep.equal([
                { command: "M", values: [0, 0] },
                { command: "a", values: [25, 26, -30, 0, 1, 50, -25] },
            ]);
        });

        it("with a closepath without arguments", function () {
            expect(readPathData("M0 0Zz")).to.deep.equal([
                { command: "M", values: [0, 0] },
                { command: "Z", values: [] },
                { command: "z", values: [] },
            ]);
        });

        it("as an empty list for an empty value", function () {
            expect(readPathData(" ")).to.deep.equal([]);
        });
    });
});
