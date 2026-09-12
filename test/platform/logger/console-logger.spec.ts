import "reflect-metadata";
import { expect } from "chai";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { Level } from "app/platform/logger/logger.types";
import { UnknownObject } from "app/shared/types";
import { RuntimeError } from "app/shared/errors";
import { RequestContext } from "app/platform/request-context/request-context";

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
        const payload = logAndParsePayload({ cause: new Error("boom") }) as { cause: UnknownObject };

        expect(payload.cause).to.include({ name: "Error", message: "boom" });
        expect(payload.cause["stack"]).to.be.a("string");
    });

    it("prints the cause of a nested error", function () {
        const payload = logAndParsePayload({ cause: new RuntimeError("failed", new Error("boom")) }) as { cause: UnknownObject };
        const cause = payload.cause["cause"] as UnknownObject;

        expect(cause).to.include({ name: "Error", message: "boom" });
    });

    it("prints a cause that is not an Error a level deeper than a parsed one", function () {
        const parsed = logAndParsePayload({ cause: new RuntimeError("failed", { cause: new Error("boom") }) }) as { cause: UnknownObject };
        const asIs = logAndParsePayload({ cause: new RuntimeError("failed", { cause: "boom" }) }) as { cause: UnknownObject };

        // Вызов один и тот же, тип пойманного разный — и значение оказывается на разной
        // глубине записи: Error конструктор поднял в нативный cause и сериализатор его
        // разобрал, строку он оставил в payload и скопировал как есть.
        expect(parsed.cause["cause"]).to.include({ name: "Error", message: "boom" });
        expect(asIs.cause["cause"]).to.be.undefined;
        expect((asIs.cause["payload"] as UnknownObject)["cause"]).to.equal("boom");
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
