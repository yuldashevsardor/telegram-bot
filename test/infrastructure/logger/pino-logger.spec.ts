import "reflect-metadata";
import { expect } from "chai";
import { PinoLogger } from "app/infrastructure/logger/pino-logger";
import { Level } from "app/domain/logger/logger.types";
import { RequestContext } from "app/infrastructure/request-context";

// pino пишет в process.stdout, поэтому записи снимаются подменой write — так же, как
// записи ConsoleLogger снимаются подменой console. Логгер строится уже после подмены:
// назначение pino выбирает в конструкторе.
function capture(write: (logger: PinoLogger, requestContext: RequestContext) => void): Array<Record<string, unknown>> {
    const original = process.stdout.write;
    let captured = "";
    process.stdout.write = ((chunk: string): boolean => {
        captured += chunk;

        return true;
    }) as typeof process.stdout.write;

    const requestContext = new RequestContext();
    const logger = new PinoLogger(requestContext);
    logger.setLevel(Level.INFO);

    try {
        write(logger, requestContext);
    } finally {
        process.stdout.write = original;
    }

    // Иначе пустой перехват уходил бы в JSON.parse и падал SyntaxError вместо внятного отказа.
    expect(captured, "pino wrote nothing to the captured stdout").to.not.equal("");

    return captured
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("PinoLogger", function () {
    it("puts the request values of the surrounding request into the record", function () {
        let requestId: string | null = null;
        const [record] = capture((logger, requestContext) =>
            requestContext.run(() => {
                requestId = requestContext.getRequestId();
                logger.info("done");
            }),
        );

        expect(record).to.include({ requestId: requestId, message: "done" });
    });

    it("writes no request data outside a request", function () {
        const [record] = capture((logger) => logger.info("done"));

        expect(record).to.not.have.property("requestId");
    });
});
