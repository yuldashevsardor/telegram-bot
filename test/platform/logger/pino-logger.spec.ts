import "reflect-metadata";
import { expect } from "chai";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import { RequestContext } from "app/platform/request-context/request-context";

// pino пишет в process.stdout, поэтому записи снимаются подменой write — так же, как
// записи ConsoleLogger снимаются подменой console. Логгер строится уже после подмены:
// назначение pino выбирает в конструкторе.
// Результат write возвращается наружу: значение из области запроса (тот же requestId)
// иначе пришлось бы ловить присваиванием в замыкание, а его тип к моменту проверки
// TypeScript сузил бы до начального.
function capture<Result>(write: (logger: PinoLogger, requestContext: RequestContext) => Result): [Array<Record<string, unknown>>, Result] {
    const original = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: string): boolean => {
        captured += chunk;

        return true;
    }) as typeof process.stdout.write;

    const requestContext = new RequestContext();
    const logger = new PinoLogger(requestContext);
    logger.setLevel(Level.INFO);

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
});
