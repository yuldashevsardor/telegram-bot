import "reflect-metadata";
import { expect } from "chai";
import { ConsoleLogger } from "app/infrastructure/logger/console.logger";
import { Level } from "app/domain/logger/logger.types";
import { UnknownObject } from "app/common/types";

function logAndParsePayload(payload: UnknownObject): unknown {
    const logger = new ConsoleLogger();
    logger.setLevels([Level.ERROR]);

    const original = console.error;
    let captured = "";
    console.error = (message: string): void => {
        captured = message;
    };

    try {
        logger.error("failed", payload);
    } finally {
        console.error = original;
    }

    return JSON.parse(captured.slice(captured.indexOf("{")));
}

describe("ConsoleLogger", function () {
    it("prints a nested error with its message and stack", function () {
        const payload = logAndParsePayload({ error: new Error("boom") }) as { error: UnknownObject };

        expect(payload.error).to.include({ name: "Error", message: "boom" });
        expect(payload.error["stack"]).to.be.a("string");
    });

    it("keeps a payload without errors as is", function () {
        const payload = logAndParsePayload({ userId: 42, formats: ["ttf", "woff2"] });

        expect(payload).to.deep.equal({ userId: 42, formats: ["ttf", "woff2"] });
    });
});
