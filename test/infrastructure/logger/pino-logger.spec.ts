import "reflect-metadata";
import { expect } from "chai";
import { AsyncLocalStorage } from "async_hooks";
import { PinoLogger } from "app/infrastructure/logger/pino-logger";
import { Level } from "app/domain/logger/logger.types";
import { ALS_KEYS } from "app/infrastructure/async-local-storage";
import { AlsStore } from "app/infrastructure/async-local-storage.types";

// pino пишет в process.stdout, поэтому записи снимаются подменой write — так же, как
// записи ConsoleLogger снимаются подменой console.
function capture(write: (logger: PinoLogger, storage: AsyncLocalStorage<AlsStore>) => void): Array<Record<string, unknown>> {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string): boolean => {
        captured += chunk;

        return true;
    }) as typeof process.stdout.write;

    const storage = new AsyncLocalStorage<AlsStore>();
    const logger = new PinoLogger(storage);
    logger.setLevel(Level.INFO);

    try {
        write(logger, storage);
    } finally {
        process.stdout.write = original;
    }

    return captured
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("PinoLogger", function () {
    it("puts the request store of the surrounding request into the record", function () {
        const [record] = capture((logger, storage) => storage.run({ [ALS_KEYS.REQUEST_ID]: "req-1" }, () => logger.info("done")));

        expect(record).to.include({ requestId: "req-1", message: "done" });
    });

    it("writes no request data outside a request", function () {
        const [record] = capture((logger) => logger.info("done"));

        expect(record).to.not.have.property("requestId");
    });
});
