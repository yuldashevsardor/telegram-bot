import "reflect-metadata";
import path from "path";
import { expect } from "chai";
import { Api, Composer, Context as GrammyContext } from "grammy";
import type { Update, UserFromGetMe } from "@grammyjs/types";
import type { Context } from "app/telegram/bot/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { Bot } from "app/telegram/bot/bot";
import type { Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { BulkMessagesCommand } from "app/telegram/command/bulk-messages/bulk-messages.command";
import { container } from "app/bootstrap/container/container";
import { Tokens } from "app/shared/tokens";
import { FileHelper } from "app/shared/fs/file-helper";
import { InvalidPath } from "app/shared/fs/file-helper.errors";
import { StringHelper } from "app/shared/string/string-helper";
import { createFluent } from "app/telegram/locale/locale";
import { DEFAULT_LOCALE } from "app/telegram/locale/locale.types";

type Pushed = { task: Task; priority: Priority };

const CHATS = [2815426, 5067823410, 858262157];
const TEXT = "random text";

const ME = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" } as UserFromGetMe;

function commandUpdate(text: string): Update {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            date: 0,
            chat: { id: 1, type: "private", first_name: "User" },
            from: { id: 1, is_bot: false, first_name: "User" },
            text: text,
            entities: [{ type: "bot_command", offset: 0, length: text.length }],
        },
    };
}

describe("BulkMessagesCommand", function () {
    // 300 000 pushes per call: even with the stubs below the run takes seconds, not milliseconds.
    this.timeout(10000);

    const pushed: Pushed[] = [];
    const sent: Array<{ chatId: number; text: string }> = [];
    const infos: string[] = [];
    const textLengths: number[] = [];

    const bot = {
        grammy: {
            api: {
                sendMessage: async (chatId: number, text: string): Promise<void> => {
                    sent.push({ chatId: chatId, text: text });
                },
            },
        },
    } as unknown as Bot;

    const taskQueue = {
        push: (task: Task, priority: Priority): void => {
            pushed.push({ task: task, priority: priority });
        },
    } as unknown as TaskQueue;

    const logger: Logger = {
        critical: () => undefined,
        error: () => undefined,
        warning: () => undefined,
        info: (message: string): void => {
            infos.push(message);
        },
        debug: () => undefined,
    };

    // The command is a test one (see the overview in docs/architecture/README.md): it takes Bot
    // and TaskQueue from the global container and creates the date directory under the path of
    // the author's machine. That is why the container bindings and the FileHelper call are
    // stubbed. The string generator is stubbed for time: 300 000 real strings of 1000 characters
    // are seconds on every run, and the generator has a spec of its own. Everything is restored
    // afterwards: the container and the classes are shared by the whole mocha run.
    const originalCreateDirectoriesByDate = FileHelper.createDirectoriesByDate.bind(FileHelper);
    const originalGenerateRandomString = StringHelper.generateRandomString.bind(StringHelper);

    before(function () {
        container.snapshot();
        container.bind<Bot>(Tokens.Bot.Bot).toConstantValue(bot);
        container.bind<TaskQueue>(Tokens.Bot.OutboundQueue.TaskQueue).toConstantValue(taskQueue);
        StringHelper.generateRandomString = (length: number): string => {
            textLengths.push(length);

            return TEXT;
        };
    });

    after(function () {
        container.restore();
        FileHelper.createDirectoriesByDate = originalCreateDirectoriesByDate;
        StringHelper.generateRandomString = originalGenerateRandomString;
    });

    async function run(createDirectoriesByDate: (basePath: string) => Promise<string>): Promise<unknown> {
        pushed.length = 0;
        sent.length = 0;
        infos.length = 0;
        textLengths.length = 0;
        FileHelper.createDirectoriesByDate = createDirectoriesByDate;

        // The update goes through setup(), as in Bot: the command has to answer to its own name.
        const ctx = new GrammyContext(commandUpdate("/bulk_messages"), new Api("test-token"), ME) as Context;
        const composer = new Composer<Context>();
        new BulkMessagesCommand(logger).setup(composer);

        return Promise.resolve()
            .then(() => composer.middleware()(ctx, () => Promise.resolve()))
            .then(
                () => undefined,
                (error: unknown) => error,
            );
    }

    describe("when the date directory is created", function () {
        const basePaths: string[] = [];

        before(async function () {
            await run(async (basePath: string): Promise<string> => {
                basePaths.push(basePath);

                return basePath;
            });
        });

        it("queues 100 000 messages per chat with low priority", function () {
            expect(pushed).to.have.lengthOf(CHATS.length * 100000);

            for (const chatId of CHATS) {
                expect(pushed.filter(({ task }) => task.key === chatId)).to.have.lengthOf(100000);
            }

            expect(pushed.every(({ priority, task }) => priority === Priority.LOW && task.priorityOnError === Priority.MEDIUM)).to.equal(
                true,
            );
        });

        it("creates the date directory under the path of the author's machine for every message", function () {
            expect(basePaths).to.have.lengthOf(pushed.length);
            expect(new Set(basePaths)).to.deep.equal(new Set(["/home/sardor/applications/telegram-bot/tmp"]));
        });

        it("logs once everything is queued", function () {
            expect(infos).to.deep.equal(["Bulk messages are pushed to the queue."]);
        });

        // The call goes past ctx.api, so TelegramCallApiMiddleware does not intercept it: the
        // command pushes the task into the queue itself, and the task calls bot.grammy.api directly.
        it("sends a random text of 1000 characters through bot.grammy.api when the task runs", async function () {
            const first = pushed[0] as Pushed;

            await first.task.callback();

            expect(textLengths.every((length) => length === 1000)).to.equal(true);
            expect(sent).to.deep.equal([{ chatId: first.task.key, text: TEXT }]);
        });
    });

    // This is how the command behaves on any machine but the author's: the path is not there, and
    // it never gets as far as push() (docs/architecture/bot.md, "Commands").
    it("rejects without queueing and logging when the date directory cannot be created", async function () {
        // One instance for all 300 000 refusals: a stack for every new error is another second.
        const error = InvalidPath.isNotExist("/missing");
        const caught = await run(() => Promise.reject(error));

        expect(caught).to.equal(error);
        expect(pushed).to.have.lengthOf(0);
        expect(infos).to.have.lengthOf(0);
    });

    // Bot takes the description for the command menu by translating descriptionKey; a key without
    // a translation Fluent gives back as `{key}`. A key missing in another locale Fluent silently
    // takes from the default one, which "declares the same keys in every locale" in locale.spec.ts
    // catches.
    it("has a translated description for the command menu", async function () {
        const fluent = await createFluent(path.join(process.cwd(), "src", "telegram"));
        const { descriptionKey } = new BulkMessagesCommand(logger);

        expect(fluent.translate(DEFAULT_LOCALE, descriptionKey)).to.not.equal(`{${descriptionKey}}`);
    });
});
