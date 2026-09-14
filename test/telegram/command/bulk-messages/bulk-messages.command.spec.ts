import "reflect-metadata";
import { expect } from "chai";
import type { Context } from "app/telegram/bot.types";
import type { Logger } from "app/platform/logger/logger";
import type { Bot } from "app/telegram/bot";
import type { Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { BulkMessagesCommand } from "app/telegram/command/bulk-messages/bulk-messages.command";
import { container } from "app/bootstrap/container/container";
import { Tokens } from "app/shared/tokens";
import { FileHelper } from "app/shared/fs/file-helper";
import { InvalidPath } from "app/shared/fs/file-helper.errors";
import { StringHelper } from "app/shared/string/string-helper";

type Pushed = { task: Task; priority: Priority };

class ExposedBulkMessagesCommand extends BulkMessagesCommand {
    public run(ctx: Context): Promise<void> {
        return this.handle(ctx);
    }
}

const CHATS = [2815426, 5067823410, 858262157];
const TEXT = "random text";

describe("BulkMessagesCommand", function () {
    // 300 000 постановок за вызов: даже с подменами ниже прогон идёт секунды, а не миллисекунды.
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

    // Команда тестовая (docs/architecture/README.md, «Обзор»): Bot и TaskQueue она берёт из
    // глобального container, а каталог по дате заводит по пути машины автора. Поэтому
    // подменяются привязки контейнера и вызов FileHelper. Генератор строк подменён ради
    // времени: 300 000 настоящих строк по 1000 символов — секунды на каждый прогон, а у
    // самого генератора своя спека. После спеки всё возвращается: контейнер и классы общие
    // на весь прогон mocha.
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

        return new ExposedBulkMessagesCommand(logger).run({} as Context).then(
            () => undefined,
            (error: unknown) => error,
        );
    }

    describe("when the date directory is created", function () {
        const basePaths: string[] = [];

        before(async function () {
            // Массив живёт в describe, а не в before: без очистки повторный прогон спеки в том же
            // процессе (make mutation) копил бы пути от прошлого и падал.
            basePaths.length = 0;

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

        it("creates the date directory for every message", function () {
            expect(basePaths).to.have.lengthOf(pushed.length);
        });

        it("logs once everything is queued", function () {
            expect(infos).to.deep.equal(["Bulk messages are pushed to the queue."]);
        });

        // Вызов идёт мимо ctx.api, поэтому TelegramCallApiMiddleware его не перехватит: в очередь
        // команда кладёт задачу сама, и задача зовёт bot.grammy.api напрямую.
        it("sends a random text of 1000 characters through bot.grammy.api when the task runs", async function () {
            const first = pushed[0] as Pushed;

            await first.task.callback();

            expect(textLengths.every((length) => length === 1000)).to.equal(true);
            expect(sent).to.deep.equal([{ chatId: first.task.key, text: TEXT }]);
        });
    });

    // Так команда ведёт себя на любой машине, кроме машины автора: пути нет, и до push()
    // дело не доходит (docs/architecture/bot.md, «Команды»).
    it("rejects without queueing and logging when the date directory cannot be created", async function () {
        // Один экземпляр на все 300 000 отказов: стек у каждой новой ошибки — ещё секунда.
        const error = InvalidPath.isNotExist("/missing");
        const caught = await run(() => Promise.reject(error));

        expect(caught).to.equal(error);
        expect(pushed).to.have.lengthOf(0);
        expect(infos).to.have.lengthOf(0);
    });
});
