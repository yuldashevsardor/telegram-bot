import "reflect-metadata";
import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/context/application-context.errors";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { PinoLogger } from "app/platform/logger/pino-logger";
import { Level } from "app/platform/logger/logger.types";
import type { RequestContext } from "app/platform/request-context/request-context";
import { InvalidConfigError } from "app/shared/errors";
import { ConfigFileStorage } from "app/bootstrap/config/storage/file/config-file-storage";
import type { UnknownObject } from "app/shared/types";
import { resetApplicationContext } from "test/bootstrap/application/application-context.helper";
import { replace } from "test/bootstrap/config/storage/config-file-storage.helper";

// The fields of the logger are protected, and they are exactly what has to be checked: the
// threshold came from the config, and the request context is the same one ApplicationContext hands
// out — with a foreign one correlation would break silently.
type LoggerParts = {
    level: Level;
    requestContext: RequestContext;
};

// An edit of the file is picked up by the configuration through polling, so the spec waits not for
// a promise but for the result to appear.
async function waitFor(done: () => boolean, reason: string, timeout = 2000): Promise<void> {
    const deadline = Date.now() + timeout;

    while (!done()) {
        if (Date.now() > deadline) {
            expect.fail(reason);
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

// The watched file is edited by the replace() helper — why not by a plain fs.writeFile is said in
// config-file-storage.helper.ts. The writes before create() go through an ordinary fs.writeFile:
// watching is started by create() itself, so there is nowhere for a poll to land.

// create() assembles the config from the environment of the process, so the spec changes
// process.env and after every test puts it back and resets the context.
describe("ApplicationContext", function () {
    const originalEnv = new Map<string, string | undefined>();

    function unsetEnv(key: string): void {
        if (!originalEnv.has(key)) {
            originalEnv.set(key, process.env[key]);
        }

        delete process.env[key];
    }

    function setEnv(values: Record<string, string>): void {
        for (const [key, value] of Object.entries(values)) {
            if (!originalEnv.has(key)) {
                originalEnv.set(key, process.env[key]);
            }

            process.env[key] = value;
        }
    }

    // The real create() starts watching the config file, so the spec keeps a directory of its own:
    // the working directory of a run may hold no such file at all, and somebody else's must not be
    // replaced.
    let directory: string;
    let filePath: string;

    // The config requires BOT_TOKEN, while the environment of a run does not have to hold a real
    // token.
    beforeEach(async function () {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "application-context-"));
        filePath = path.join(directory, ".runtime.env");

        // By default the poll is rare: it will not fire once before the end of the test, and the
        // tests that need watching set an interval of their own. There is nothing to switch it off
        // with — the minimum is set by the configuration — so every test kills the source in
        // afterEach: mocha has no --exit.
        setEnv({ BOT_TOKEN: "test-token", CONFIG_FILE_PATH: filePath, CONFIG_FILE_WATCH_INTERVAL: "100000" });
    });

    // One hook and not two: watching has to die before its directory, otherwise a poll catches the
    // disappearance of the file and rebuilds the configuration of a test that is already over — with
    // a call of the listeners and a write into the log.
    afterEach(async function () {
        resetApplicationContext();

        for (const [key, value] of originalEnv) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }

        originalEnv.clear();

        await fs.rm(directory, { recursive: true, force: true });
    });

    it("throws ApplicationContextIsNotCreated from every getter before create()", function () {
        const message = "ApplicationContext is not created, call create() first.";

        expect(() => ApplicationContext.getConfigContainer())
            .to.throw(ApplicationContextIsNotCreated)
            .with.property("message", message);
        expect(() => ApplicationContext.getLogger())
            .to.throw(ApplicationContextIsNotCreated)
            .with.property("message", message);
        expect(() => ApplicationContext.getRequestContext())
            .to.throw(ApplicationContextIsNotCreated)
            .with.property("message", message);
    });

    it("builds a console logger outside production with the configured level and the request context it hands out", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "error" });

        await ApplicationContext.create();

        const logger = ApplicationContext.getLogger();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
        expect(logger).to.be.instanceOf(ConsoleLogger);
        expect((logger as unknown as LoggerParts).level).to.equal(Level.ERROR);
        expect((logger as unknown as LoggerParts).requestContext).to.equal(ApplicationContext.getRequestContext());
    });

    it("builds a pino logger in production", async function () {
        setEnv({ NODE_ENV: "production", LOGGER_LEVEL: "critical" });

        await ApplicationContext.create();

        const logger = ApplicationContext.getLogger();

        expect(logger).to.be.instanceOf(PinoLogger);
        expect((logger as unknown as LoggerParts).level).to.equal(Level.CRITICAL);
        expect((logger as unknown as LoggerParts).requestContext).to.equal(ApplicationContext.getRequestContext());
    });

    it("keeps the parts on a repeated create() even when the environment has changed", async function () {
        setEnv({ NODE_ENV: "development" });
        await ApplicationContext.create();

        const cc = ApplicationContext.getConfigContainer();
        const logger = ApplicationContext.getLogger();
        const requestContext = ApplicationContext.getRequestContext();

        setEnv({ NODE_ENV: "production" });
        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer()).to.equal(cc);
        expect(ApplicationContext.getLogger()).to.equal(logger);
        expect(ApplicationContext.getRequestContext()).to.equal(requestContext);
    });

    // The assembly is asynchronous: a check of the ready parts would let both calls through, and the
    // second one would assemble a second context on top of the first.
    it("waits for the create() in progress instead of starting another one", async function () {
        setEnv({ NODE_ENV: "development" });
        const first = ApplicationContext.create();

        setEnv({ NODE_ENV: "production" });
        const second = ApplicationContext.create();
        await Promise.all([first, second]);

        expect(second).to.equal(first);
        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
    });

    it("builds the context again once its parts have been reset", async function () {
        setEnv({ NODE_ENV: "development" });
        await ApplicationContext.create();
        resetApplicationContext();

        setEnv({ NODE_ENV: "production" });
        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("production");
    });

    it("stays empty when the config fails, so the next create() starts from scratch", async function () {
        setEnv({ NODE_ENV: "prod" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(InvalidConfigError);
        expect(() => ApplicationContext.getConfigContainer()).to.throw(ApplicationContextIsNotCreated);
        expect(() => ApplicationContext.getLogger()).to.throw(ApplicationContextIsNotCreated);
        expect(() => ApplicationContext.getRequestContext()).to.throw(ApplicationContextIsNotCreated);

        setEnv({ NODE_ENV: "production" });
        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("production");
    });

    // A variable that is set in the environment beats the file, and a blank one yields to it: what
    // can be changed on the fly is what the environment does not hold.
    it("builds the config with the environment winning over the file", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "debug" });
        await fs.writeFile(filePath, "LOGGER_LEVEL=error\n");

        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.DEBUG);

        resetApplicationContext();
        setEnv({ LOGGER_LEVEL: "" });

        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.ERROR);
    });

    // Watching is switched on by the context itself: without it an edit of the file would stay
    // unnoticed until a restart, and the subscriptions would mean nothing.
    it("watches the file it was pointed at, so a change reaches the config by itself", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "", CONFIG_FILE_WATCH_INTERVAL: "100" });

        await ApplicationContext.create();

        const cc = ApplicationContext.getConfigContainer();
        const levels: Level[] = [];

        cc.onChange("logger.level", (newValue) => {
            levels.push(newValue);
        });

        await replace(filePath, "LOGGER_LEVEL=error\n");
        // The deadline is short on purpose: with the default interval (2000 ms) the edit would not
        // arrive within it, so the test holds the interval as well and not only the fact of
        // watching.
        await waitFor(() => levels.length > 0, "the change of the file did not reach the config", 1500);

        expect(levels).to.deep.equal([Level.ERROR]);
        expect(cc.get("logger.level")).to.equal(Level.ERROR);
    });

    // The default path is <application root>/.runtime.env, and inside the container a file of the
    // same name from the host is mounted there; a mistake in it would mean the application watches
    // the wrong file.
    it("falls back to .runtime.env in the working directory", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "" });
        unsetEnv("CONFIG_FILE_PATH");
        unsetEnv("CONFIG_FILE_WATCH_INTERVAL");

        await fs.writeFile(path.join(directory, ".runtime.env"), "LOGGER_LEVEL=error\n");

        const cwd = process.cwd();

        process.chdir(directory);

        try {
            await ApplicationContext.create();
        } finally {
            process.chdir(cwd);
        }

        expect(ApplicationContext.getConfigContainer().get("logger.level")).to.equal(Level.ERROR);
    });

    // Watching is started by init() of the container, that is before the context is filled: were the
    // assembly to fail between them, the poll would stay running and there would be nothing to reach
    // it with — there is no reference to the container anywhere.
    it("unwatches the config file when the rest of the context fails to assemble", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "100" });

        const failure = new Error("logger is broken");
        const parts = ApplicationContext as unknown as { createLogger: () => never };
        const originalCreateLogger = parts.createLogger;
        const originalUnwatch = ConfigFileStorage.prototype.unwatch;
        let unwatches = 0;

        parts.createLogger = (): never => {
            throw failure;
        };
        ConfigFileStorage.prototype.unwatch = function unwatch(this: ConfigFileStorage): void {
            unwatches += 1;

            originalUnwatch.call(this);
        };

        try {
            const error = await ApplicationContext.create().then(
                () => expect.fail("create() was expected to reject"),
                (reason: unknown) => reason,
            );

            expect(error).to.equal(failure);
            expect(unwatches).to.equal(1);
        } finally {
            parts.createLogger = originalCreateLogger;
            ConfigFileStorage.prototype.unwatch = originalUnwatch;
        }
    });

    // A failed rebuild does not bring the process down: the application stays on the previous
    // values, and the reason goes into the log — the configuration itself has no logger, it is
    // assembled before one.
    it("logs a failed reload and keeps the previous values", async function () {
        this.timeout(6000);

        // NODE_ENV is taken off the environment: a variable that is set beats the file, so a value
        // that is not allowed cannot be slipped into the file on top of it.
        setEnv({ CONFIG_FILE_WATCH_INTERVAL: "100" });
        unsetEnv("NODE_ENV");
        await ApplicationContext.create();

        const records: Array<{ message: string; payload: UnknownObject | undefined }> = [];
        const logger = ApplicationContext.getLogger();

        logger.error = (message: string, payload?: UnknownObject): void => {
            records.push({ message: message, payload: payload });
        };

        await replace(filePath, "NODE_ENV=prod\n");
        await waitFor(() => records.length > 0, "the failed reload did not reach the log", 4000);

        expect(records[0]?.message).to.equal("Config reload failed, the previous values are kept.");
        expect(records[0]?.payload?.["cause"]).to.be.instanceOf(InvalidConfigError);
        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
    });

    it("fails the start on an interval that is not a whole number of milliseconds", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "half a second" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error)
            .to.be.instanceOf(InvalidConfigError)
            .with.property("message", 'Config value "CONFIG_FILE_WATCH_INTERVAL" must be an integer');
    });

    // A huge interval is turned by a Node timer into 1 ms, so "once a day" would become a poll on
    // every turn of the loop; a negative one becomes the same thing.
    it("fails the start on an interval a timer cannot hold", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "2147483648" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error).to.be.instanceOf(InvalidConfigError);

        setEnv({ CONFIG_FILE_WATCH_INTERVAL: "-1" });

        const negative = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(negative).to.be.instanceOf(InvalidConfigError);
    });

    // A blank variable, and spaces around a value, are the same as the variable not being set:
    // otherwise a path with a trailing space would take watching to a file that does not exist, and
    // an interval would not parse at all.
    it("treats a blank path and a padded value as if they were not set", async function () {
        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "", CONFIG_FILE_PATH: "   ", CONFIG_FILE_WATCH_INTERVAL: "  100  " });

        await fs.writeFile(path.join(directory, ".runtime.env"), "LOGGER_LEVEL=error\n");

        const cwd = process.cwd();

        process.chdir(directory);

        try {
            await ApplicationContext.create();
        } finally {
            process.chdir(cwd);
        }

        const cc = ApplicationContext.getConfigContainer();

        expect(cc.get("logger.level")).to.equal(Level.ERROR);

        // The interval was parsed as 100 ms and not dropped: the edit arrives long before the
        // default would let it.
        await replace(path.join(directory, ".runtime.env"), "LOGGER_LEVEL=warning\n");
        await waitFor(() => cc.get("logger.level") === Level.WARNING, "the padded interval was not applied", 1500);
    });

    // The upper bound of the interval is accepted by the application: it is the longest delay a Node
    // timer holds, and at it watching is still legitimate.
    it("accepts the longest interval a timer can hold", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "2147483647" });

        await ApplicationContext.create();

        expect(ApplicationContext.getConfigContainer().get("environment")).to.equal("development");
    });

    // A value of spaces is the same as none: without trimming it would become a zero, that is it
    // would silently switch watching off. Hence the deadline of the test: it has to cover the default
    // interval.
    it("watches with the default interval when the variable holds only spaces", async function () {
        this.timeout(8000);

        setEnv({ NODE_ENV: "development", LOGGER_LEVEL: "", CONFIG_FILE_WATCH_INTERVAL: "   " });
        await ApplicationContext.create();

        const cc = ApplicationContext.getConfigContainer();

        await replace(filePath, "LOGGER_LEVEL=error\n");
        await waitFor(
            () => cc.get("logger.level") === Level.ERROR,
            "the change of the file did not reach the config within the default interval",
            5000,
        );
    });

    // The poll does not go below a hundred: configuration is not edited more often, and a stat on
    // every turn of the loop is not free.
    it("fails the start on an interval below the minimum", async function () {
        setEnv({ NODE_ENV: "development", CONFIG_FILE_WATCH_INTERVAL: "50" });

        const error = await ApplicationContext.create().then(
            () => expect.fail("create() was expected to reject"),
            (reason: unknown) => reason,
        );

        expect(error)
            .to.be.instanceOf(InvalidConfigError)
            .with.property("message", 'Config value "CONFIG_FILE_WATCH_INTERVAL" must be between 100 and 2147483647');
    });
});
