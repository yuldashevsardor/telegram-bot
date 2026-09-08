import "reflect-metadata";
import { expect } from "chai";
import { ConsoleLogger } from "app/infrastructure/logger/console-logger";
import { Level } from "app/domain/logger/logger.types";
import { UnknownObject } from "app/common/types";
import { RuntimeError } from "app/common/errors";
import { RequestContext } from "app/infrastructure/request-context";

// Контекст свой, а не production-синглтон: спека не зависит от того, открыл ли кто-то
// область запроса рядом.
const requestContext = new RequestContext();

function capture(method: "error" | "info", write: (logger: ConsoleLogger) => void): string {
    const original = console[method];
    let captured = "";
    console[method] = (message: string): void => {
        captured = message;
    };

    const logger = new ConsoleLogger(requestContext);
    logger.setLevel(Level.ERROR);

    try {
        write(logger);
    } finally {
        console[method] = original;
    }

    return captured;
}

function logAndParsePayload(payload: UnknownObject): unknown {
    const captured = capture("error", (logger) => logger.error("failed", payload));

    return JSON.parse(captured.slice(captured.indexOf("{")));
}

describe("ConsoleLogger", function () {
    it("prints a nested error with its message and stack", function () {
        const payload = logAndParsePayload({ error: new Error("boom") }) as { error: UnknownObject };

        expect(payload.error).to.include({ name: "Error", message: "boom" });
        expect(payload.error["stack"]).to.be.a("string");
    });

    it("prints the cause of a nested error", function () {
        const payload = logAndParsePayload({ error: new RuntimeError("failed", new Error("boom")) }) as { error: UnknownObject };
        const cause = payload.error["cause"] as UnknownObject;

        expect(cause).to.include({ name: "Error", message: "boom" });
    });

    it("keeps a payload without errors as is", function () {
        const payload = logAndParsePayload({ userId: 42, formats: ["ttf", "woff2"] });

        expect(payload).to.deep.equal({ userId: 42, formats: ["ttf", "woff2"] });
    });

    it("skips a level below the configured one", function () {
        expect(capture("info", (logger) => logger.info("skipped"))).to.equal("");
    });

    it("prints a level above the configured one", function () {
        expect(capture("error", (logger) => logger.critical("printed"))).to.contain("[CRITICAL] printed");
    });

    it("prints the request values of the surrounding request", function () {
        const { captured, requestId } = requestContext.run(() => ({
            captured: capture("error", (logger) => logger.error("failed")),
            requestId: requestContext.getRequestId(),
        }));

        expect(captured).to.contain(`[requestId=${String(requestId)}]`);
    });

    it("prints nothing extra outside a request", function () {
        expect(capture("error", (logger) => logger.error("failed"))).to.not.contain("requestId");
    });
});
