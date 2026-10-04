// A command of `npm run cli`: the arguments that are left once the queue and the action are
// taken off. The command checks them itself, since another command may take other ones.
export interface CliCommand {
    run(args: readonly string[]): Promise<void>;
}
