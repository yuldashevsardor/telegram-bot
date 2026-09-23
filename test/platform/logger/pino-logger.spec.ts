import "reflect-metadata";
import { expect } from "chai";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import { InvalidLogLevel } from "app/platform/logger/logger.errors";
import { RequestContext } from "app/platform/request-context/request-context";

// pino writes to process.stdout, so the records are captured by replacing write — the same way
// the records of ConsoleLogger are captured by replacing console. The logger is built after the
// replacement: pino picks its destination in the constructor.
// The result of write is returned: otherwise a value from the request scope (the same requestId)
// would have to be caught by assignment in a closure, and by the time of the check TypeScript
// would have narrowed its type to the initial one.
function capture<Result>(
    write: (logger: PinoLogger, requestContext: RequestContext) => Result,
    level: Level = Level.INFO,
): [Array<Record<string, unknown>>, Result] {
    const original = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: string): boolean => {
        captured += chunk;

        return true;
    }) as typeof process.stdout.write;

    const requestContext = new RequestContext();
    const logger = new PinoLogger(requestContext);
    logger.setLevel(level);

    let result: Result;
    try {
        result = write(logger, requestContext);
    } finally {
        process.stdout.write = original;
    }

    // Otherwise an empty capture would go to JSON.parse and fail with a SyntaxError instead of a clear failure.
    expect(captured, "pino wrote nothing to the captured stdout").to.not.equal("");

    const records = captured
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    return [records, result];
}

describe("PinoLogger", function () {
    it("puts the request values of the surrounding request into the record", function () {
        const [[record], requestId] = capture((logger, requestContext) =>
            requestContext.run(() => {
                logger.info("done");

                return requestContext.getRequestId();
            }),
        );

        expect(requestId).to.be.a("string");
        expect(record).to.include({ requestId: requestId, message: "done" });
    });

    it("writes no request data outside a request", function () {
        const [[record]] = capture((logger) => logger.info("done"));

        expect(record).to.not.have.property("requestId");
    });

    const writes = [
        { level: Level.CRITICAL, write: (logger: PinoLogger): void => logger.critical("done") },
        { level: Level.ERROR, write: (logger: PinoLogger): void => logger.error("done") },
        { level: Level.WARNING, write: (logger: PinoLogger): void => logger.warning("done") },
        { level: Level.INFO, write: (logger: PinoLogger): void => logger.info("done") },
        { level: Level.DEBUG, write: (logger: PinoLogger): void => logger.debug("done") },
    ];

    for (const { level, write } of writes) {
        it(`writes ${level} as the record level at the ${level} threshold`, function () {
            const [[record]] = capture(write, level);

            expect(record).to.include({ level: level, message: "done" });
        });
    }

    it("puts a nested error of the payload into the record with its message and stack", function () {
        const [[record]] = capture((logger) => logger.error("failed", { cause: new Error("boom") }));
        const cause = (record?.["payload"] as { cause: Record<string, unknown> }).cause;

        expect(cause).to.include({ name: "Error", message: "boom" });
        expect(cause["stack"]).to.be.a("string");
    });

    it("writes no payload into a record without one", function () {
        const [[record]] = capture((logger) => logger.info("done"));

        expect(record).to.not.have.property("payload");
    });

    it("rejects an unknown level before handing it to pino", function () {
        const logger = new PinoLogger(new RequestContext());

        // The refusal comes from AbstractLogger. The override must call it before assigning the
        // pino level: otherwise a bare pino Error would be thrown instead of InvalidLogLevel.
        expect(() => logger.setLevel("TRACE" as Level))
            .to.throw(InvalidLogLevel)
            .with.property("message", "Invalid log level. Got: TRACE");
    });
});
