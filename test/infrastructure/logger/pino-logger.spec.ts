import "reflect-metadata";
import { expect } from "chai";
import { PinoLogger } from "app/infrastructure/logger/pino-logger";
import { Level } from "app/domain/logger/logger.types";
import { AlsKey, runWithAlsStore } from "app/infrastructure/async-local-storage";

// pino пишет в process.stdout, поэтому записи снимаются подменой write — так же, как
// записи ConsoleLogger снимаются подменой console.
function capture(write: (logger: PinoLogger) => void): Array<Record<string, unknown>> {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string): boolean => {
        captured += chunk;

        return true;
    }) as typeof process.stdout.write;

    const logger = new PinoLogger();
    logger.setLevel(Level.INFO);

    try {
        write(logger);
    } finally {
        process.stdout.write = original;
    }

    return captured
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("PinoLogger", function () {
    it("puts the request id of the surrounding request into the record", function () {
        const [record] = capture((logger) => runWithAlsStore({ [AlsKey.RequestId]: "req-1" }, () => logger.info("done")));

        expect(record).to.include({ requestId: "req-1", message: "done" });
    });

    it("writes no request id outside a request", function () {
        const [record] = capture((logger) => logger.info("done"));

        expect(record).to.not.have.property("requestId");
    });
});
