import "reflect-metadata";
import { container } from "app/bootstrap/container/container";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import { ApplicationContextIsNotCreated } from "app/bootstrap/application/context/application-context.errors";
import { Tokens } from "app/shared/tokens";
import type { CliCommandResolver } from "app/cli/cli-command-resolver";

// The entry point of `npm run cli`, which the targets of the Makefile for a blocked chat or group
// run in a throwaway container: it brings up the container without the bot, resolves the command
// by the arguments, runs it and leaves. Like app.ts it has no container to be injected from, and
// it checks nothing itself: the resolvers and the commands do.
async function runCommand(): Promise<void> {
    await ApplicationContext.create();
    await container.setup();

    try {
        const { command, commandArgs } = container.get<CliCommandResolver>(Tokens.Cli.Resolver).resolve(process.argv.slice(2));

        await command.run(commandArgs);
    } finally {
        // The order of the stop of Application. process.exit(0) below ends the process anyway:
        // only without that exit would the poll of the config file keep the process alive.
        ApplicationContext.getConfigContainer().unwatch();
        await container.close();
    }
}

// The same fallback as fail() in app.ts: the console, only when the logger cannot write.
function fail(error: unknown): never {
    try {
        ApplicationContext.getLogger().error("The command failed.", { cause: error });
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

runCommand().then(() => process.exit(0), fail);
