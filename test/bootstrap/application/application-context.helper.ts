import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { ConfigContainer } from "app/bootstrap/config/container/config-container";
import type { CC, RawConfig } from "app/bootstrap/config/container/config-container.types";
import type { ConfigValues } from "app/bootstrap/config/config-values";
import { ConfigValuesBuilder } from "app/bootstrap/config/builder/config-values-builder";
import type { Logger } from "app/platform/logger/logger";
import { ConsoleLogger } from "app/platform/logger/console-logger";
import { Level } from "app/platform/logger/logger.types";
import { RequestContext } from "app/platform/request-context/request-context";

type ContextParts = {
    parts: {
        cc: CC;
        logger: Logger;
        requestContext: RequestContext;
    } | null;
};

// The parts are put into the static field past create(): that one would assemble the config from
// the real environment, and a seam for the tests would change the public shape of the context.
const context = ApplicationContext as unknown as ContextParts;

function createQuietLogger(requestContext: RequestContext): Logger {
    const logger = new ConsoleLogger(requestContext);
    logger.setLevel(Level.CRITICAL);

    return logger;
}

// Fills the context whole, as create() does, but assembles the config from the given variables
// rather than from the environment of the process. The config requires BOT_TOKEN, while the
// environment of a run does not have to hold a real token. By default the logger writes only
// critical: on construction TaskQueue starts intervals with an info log every 10 s, there is
// nothing to stop them with, and under test-watch they pile up between runs and would write into
// the output of mocha. A config that failed leaves the context empty, as in create().
export async function fillApplicationContext(values: RawConfig = {}, logger?: Logger): Promise<void> {
    const cc = new ConfigContainer<ConfigValues>(
        { load: async (): Promise<RawConfig> => ({ BOT_TOKEN: "test-token", ...values }) },
        new ConfigValuesBuilder(),
    );
    await cc.init();

    const requestContext = new RequestContext();

    context.parts = { cc: cc, logger: logger ?? createQuietLogger(requestContext), requestContext: requestContext };
}

// The context is shared by the whole mocha run: left filled, it would silently hand its config to
// configValue() in other specs. The promise of the assembly is not touched: between assemblies
// create() keeps it empty anyway, and resetting the promise would not cancel an assembly under way
// — that one would fill the context after the reset.
export function resetApplicationContext(): void {
    // Watching is removed before the reference is reset: the real create() starts a poll of the
    // config file, mocha has no --exit, and a poll left behind would hold the run until the timeout.
    context.parts?.cc.unwatch();

    context.parts = null;
}
