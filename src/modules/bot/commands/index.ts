import { Composer } from "grammy";
import { Context } from "../Context";
import { command as startCommand, handler as startHandler } from "./Start";

export const commands = new Composer<Context>();

commands.command(startCommand, startHandler);
