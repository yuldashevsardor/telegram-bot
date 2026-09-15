import { expect } from "chai";
import { ConfigReader } from "app/bootstrap/config-reader";
import type { ConfigStorage } from "app/platform/config/config-storage";
import { InvalidConfigError } from "app/shared/errors";

const Colors = ["red", "green", "blue"] as const;

type Color = (typeof Colors)[number];

function isColor(value: string): value is Color {
    return Colors.some((color) => color === value);
}

function reader(values: Record<string, string> = {}): ConfigReader {
    const storage: ConfigStorage = {
        get: (key): string | undefined => values[key],
    };

    return new ConfigReader(storage);
}

// Текст ошибки с деталями — всё, что оператор узнает о неверной переменной, поэтому сверяются оба.
function rejection(read: () => unknown): InvalidConfigError {
    try {
        read();
    } catch (error) {
        expect(error).to.be.instanceOf(InvalidConfigError);

        return error as InvalidConfigError;
    }

    return expect.fail("the value was expected to be rejected");
}

describe("ConfigReader", () => {
    describe("getString", () => {
        it("reads a trimmed value", () => {
            expect(reader({ NAME: "  value  " }).getString("NAME", "default")).to.equal("value");
        });

        it("falls back to the default on a missing or blank value", () => {
            expect(reader().getString("NAME", "default")).to.equal("default");
            expect(reader({ NAME: "   " }).getString("NAME", "default")).to.equal("default");
        });

        it("accepts an empty default", () => {
            expect(reader().getString("NAME", "")).to.equal("");
        });

        it("requires a value without a default", () => {
            const error = rejection(() => reader().getString("NAME"));

            expect(error.message).to.equal('Config value "NAME" is required');
            expect(error.payload).to.equal(undefined);
            expect(() => reader({ NAME: "  " }).getString("NAME")).to.throw(InvalidConfigError, 'Config value "NAME" is required');
        });
    });

    describe("getInteger", () => {
        it("reads an integer", () => {
            expect(reader({ NAME: " 42 " }).getInteger("NAME", 1, { min: 0 })).to.equal(42);
            expect(reader({ NAME: "-5" }).getInteger("NAME", 1, { min: -10 })).to.equal(-5);
        });

        it("falls back to the default on a missing or blank value", () => {
            expect(reader().getInteger("NAME", 7, { min: 0 })).to.equal(7);
            expect(reader({ NAME: "  " }).getInteger("NAME", 7, { min: 0 })).to.equal(7);
        });

        it("rejects a value that is not an integer", () => {
            const error = rejection(() => reader({ NAME: "10s" }).getInteger("NAME", 1, { min: 0 }));

            expect(error.message).to.equal('Config value "NAME" must be an integer');
            expect(error.payload).to.deep.equal({ got: "10s" });
            expect(() => reader({ NAME: "abc" }).getInteger("NAME", 1, { min: 0 })).to.throw(InvalidConfigError);
            expect(() => reader({ NAME: "1.5" }).getInteger("NAME", 1, { min: 0 })).to.throw(InvalidConfigError);
        });

        it("accepts both edges of the range", () => {
            expect(reader({ NAME: "3" }).getInteger("NAME", 5, { min: 3, max: 9 })).to.equal(3);
            expect(reader({ NAME: "9" }).getInteger("NAME", 5, { min: 3, max: 9 })).to.equal(9);
        });

        it("rejects a value below the minimum", () => {
            const error = rejection(() => reader({ NAME: "2" }).getInteger("NAME", 5, { min: 3 }));

            expect(error.message).to.equal('Config value "NAME" must be at least 3');
            expect(error.payload).to.deep.equal({ got: 2, min: 3 });
        });

        it("rejects a value outside the range", () => {
            const below = rejection(() => reader({ NAME: "2" }).getInteger("NAME", 5, { min: 3, max: 9 }));
            const above = rejection(() => reader({ NAME: "10" }).getInteger("NAME", 5, { min: 3, max: 9 }));

            expect(below.message).to.equal('Config value "NAME" must be between 3 and 9');
            expect(below.payload).to.deep.equal({ got: 2, min: 3, max: 9 });
            expect(above.message).to.equal('Config value "NAME" must be between 3 and 9');
            expect(above.payload).to.deep.equal({ got: 10, min: 3, max: 9 });
        });

        // Неверное умолчание — ошибка кода, но всплыть ей лучше на старте, чем у потребителя.
        it("checks the default against the range too", () => {
            expect(() => reader().getInteger("NAME", 0, { min: 1 })).to.throw(InvalidConfigError, 'Config value "NAME" must be at least 1');
        });
    });

    describe("getPort", () => {
        it("accepts the whole port range", () => {
            expect(reader({ PORT: "1" }).getPort("PORT", 5432)).to.equal(1);
            expect(reader({ PORT: "65535" }).getPort("PORT", 5432)).to.equal(65535);
            expect(reader().getPort("PORT", 5432)).to.equal(5432);
        });

        it("rejects a value outside the port range", () => {
            const error = rejection(() => reader({ PORT: "0" }).getPort("PORT", 5432));

            expect(error.message).to.equal('Config value "PORT" must be between 1 and 65535');
            expect(error.payload).to.deep.equal({ got: 0, min: 1, max: 65535 });
            expect(() => reader({ PORT: "65536" }).getPort("PORT", 5432)).to.throw(InvalidConfigError);
        });
    });

    describe("getTimerDelay", () => {
        it("accepts the longest delay a timer can hold", () => {
            expect(reader({ DELAY: "2147483647" }).getTimerDelay("DELAY", 10)).to.equal(2147483647);
        });

        it("rejects a delay that a timer would turn into 1 ms", () => {
            const zero = rejection(() => reader({ DELAY: "0" }).getTimerDelay("DELAY", 10));
            const overflow = rejection(() => reader({ DELAY: "2147483648" }).getTimerDelay("DELAY", 10));

            expect(zero.message).to.equal('Config value "DELAY" must be between 1 and 2147483647');
            expect(zero.payload).to.deep.equal({ got: 0, min: 1, max: 2147483647 });
            expect(overflow.message).to.equal('Config value "DELAY" must be between 1 and 2147483647');
        });

        it("accepts zero where the caller allows it", () => {
            expect(reader({ DELAY: "0" }).getTimerDelay("DELAY", 10, { min: 0 })).to.equal(0);
            expect(() => reader({ DELAY: "-1" }).getTimerDelay("DELAY", 10, { min: 0 })).to.throw(
                InvalidConfigError,
                'Config value "DELAY" must be between 0 and 2147483647',
            );
        });
    });

    describe("getBoolean", () => {
        it("reads true, false, 1 and 0 case-insensitively", () => {
            expect(reader({ FLAG: "true" }).getBoolean("FLAG", false)).to.equal(true);
            expect(reader({ FLAG: "TRUE" }).getBoolean("FLAG", false)).to.equal(true);
            expect(reader({ FLAG: "1" }).getBoolean("FLAG", false)).to.equal(true);
            expect(reader({ FLAG: "False" }).getBoolean("FLAG", true)).to.equal(false);
            expect(reader({ FLAG: "0" }).getBoolean("FLAG", true)).to.equal(false);
        });

        it("falls back to the default on a missing or blank value", () => {
            expect(reader().getBoolean("FLAG", true)).to.equal(true);
            expect(reader({ FLAG: " " }).getBoolean("FLAG", false)).to.equal(false);
        });

        it("rejects anything else instead of treating it as false", () => {
            const error = rejection(() => reader({ FLAG: "MAYBE" }).getBoolean("FLAG", true));

            expect(error.message).to.equal('Config value "FLAG" must be a boolean');
            expect(error.payload).to.deep.equal({ got: "MAYBE", allowed: ["true", "1", "false", "0"] });
            expect(() => reader({ FLAG: "yes" }).getBoolean("FLAG", true)).to.throw(InvalidConfigError);
            expect(() => reader({ FLAG: "2" }).getBoolean("FLAG", true)).to.throw(InvalidConfigError);
        });
    });

    describe("getEnum", () => {
        it("reads an allowed value", () => {
            expect(reader({ COLOR: "green" }).getEnum("COLOR", Colors, "red")).to.equal("green");
        });

        it("falls back to the default on a missing or blank value", () => {
            expect(reader().getEnum("COLOR", Colors, "blue")).to.equal("blue");
            expect(reader({ COLOR: " " }).getEnum("COLOR", Colors, "blue")).to.equal("blue");
        });

        it("rejects an unknown value", () => {
            const error = rejection(() => reader({ COLOR: "violet" }).getEnum("COLOR", Colors, "red"));

            expect(error.message).to.equal('Config value "COLOR" must be one of the allowed values');
            expect(error.payload).to.deep.equal({ got: "violet", allowed: ["red", "green", "blue"] });
        });

        it("compares case-sensitively by default", () => {
            expect(() => reader({ COLOR: "Green" }).getEnum("COLOR", Colors, "red")).to.throw(InvalidConfigError);
        });

        it("returns the allowed spelling when the case is ignored", () => {
            expect(reader({ COLOR: "GrEeN" }).getEnum("COLOR", Colors, "red", { ignoreCase: true })).to.equal("green");
            expect(() => reader({ COLOR: "violet" }).getEnum("COLOR", Colors, "red", { ignoreCase: true })).to.throw(InvalidConfigError);
        });
    });

    describe("getArray", () => {
        it("splits by a comma or a semicolon and trims the elements", () => {
            expect(reader({ COLORS: "red, green ;blue" }).getArray("COLORS", isColor, [])).to.deep.equal(["red", "green", "blue"]);
            expect(reader({ COLORS: "blue" }).getArray("COLORS", isColor, [])).to.deep.equal(["blue"]);
        });

        it("falls back to the default on a missing or blank value", () => {
            expect(reader().getArray("COLORS", isColor, ["red"])).to.deep.equal(["red"]);
            expect(reader({ COLORS: "  " }).getArray("COLORS", isColor, ["red"])).to.deep.equal(["red"]);
        });

        it("rejects the value naming every invalid element", () => {
            const error = rejection(() => reader({ COLORS: "red, violet; green, pink" }).getArray("COLORS", isColor, []));

            expect(error.message).to.equal('Config value "COLORS" has invalid elements');
            expect(error.payload).to.deep.equal({ got: "red, violet; green, pink", invalid: ["violet", "pink"] });
        });

        it("rejects an empty element", () => {
            const error = rejection(() => reader({ COLORS: "red,,green;" }).getArray("COLORS", isColor, []));

            expect(error.payload).to.deep.equal({ got: "red,,green;", invalid: ["", ""] });
        });
    });
});
