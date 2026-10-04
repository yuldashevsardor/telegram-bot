import "reflect-metadata";
import { container } from "app/bootstrap/container/container";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/context/application-context.errors";
import { Tokens } from "app/shared/tokens";
import type { UnblockCommandLine } from "app/telegram/unblock-command-line/unblock-command-line";

// The entry point of `npm run unblock`, which the unblock targets of the Makefile run in a
// throwaway container: it brings up the container without the bot, runs one command and leaves.
// Like app.ts it has no container to be injected from.
async function unblock(): Promise<void> {
    await ApplicationContext.create();
    await container.setup();

    try {
        await container.get<UnblockCommandLine>(Tokens.Bot.UnblockCommandLine).run(process.argv.slice(2));
    } finally {
        // The polling of the configuration file would keep the process alive.
        ApplicationContext.getConfigContainer().unwatch();
        await container.close();
    }
}

// The same fallback as fail() in app.ts: the console, only when the logger cannot write.
function fail(error: unknown): never {
    try {
        ApplicationContext.getLogger().error("The unblock failed.", { cause: error });
    } catch (loggerError) {
        if (!(loggerError instanceof ApplicationContextIsNotCreated)) {
            // eslint-disable-next-line no-console
            console.error(loggerError);
        }

        // eslint-disable-next-line no-console
        console.error(error);
    }

    process.exit(1);
}

unblock().then(() => process.exit(0), fail);
