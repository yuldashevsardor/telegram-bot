import "reflect-metadata";
import { expect } from "chai";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import { InvalidLogLevel } from "app/platform/logger/logger.errors";
import { RequestContext } from "app/platform/request-context/request-context";

// pino пишет в process.stdout, поэтому записи снимаются подменой write — так же, как
// записи ConsoleLogger снимаются подменой console. Логгер строится уже после подмены:
// назначение pino выбирает в конструкторе.
// Результат write возвращается наружу: значение из области запроса (тот же requestId)
// иначе пришлось бы ловить присваиванием в замыкание, а его тип к моменту проверки
// TypeScript сузил бы до начального.
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

    // Иначе пустой перехват уходил бы в JSON.parse и падал SyntaxError вместо внятного отказа.
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

        // Отказ даёт AbstractLogger. Переопределение обязано позвать его раньше, чем
        // присвоить уровень pino: иначе вместо InvalidLogLevel вылетел бы голый Error pino.
        expect(() => logger.setLevel("TRACE" as Level))
            .to.throw(InvalidLogLevel)
            .with.property("message", "Invalid log level. Got: TRACE");
    });
});
