import { Filter } from "grammy/out/filter";
import { Middleware } from "grammy/out/composer";
import { Context } from "./Context";

export type CommandContext<C extends Context> = Filter<
    Omit<C, "match"> & {
        match: Extract<C["match"], string>;
    },
    ":entities:bot_command"
>;

export type HearsContext<C extends Context> = Filter<
    Omit<C, "match"> & {
        match: Extract<C["match"], string | RegExpMatchArray>;
    },
    ":text" | ":caption"
>;

export type CommandHandler = Middleware<CommandContext<Context>>;

export type HearHandler = Middleware<HearsContext<Context>>;
