import "reflect-metadata";
import { expect } from "chai";
import type { RawApi, Transformer } from "grammy";
import { Api, Composer, GrammyError } from "grammy";
import type { Context } from "app/telegram/bot.types";
import type { Task } from "app/telegram/outbound-queue/task";
import { Priority } from "app/telegram/outbound-queue/task";
import type { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { TelegramCallApiMiddleware } from "app/telegram/middleware/mutation/telegram-call-api.middleware";

type RawCall = { method: string; payload: unknown; signal: unknown };

type Pushed = { task: Task; priority: Priority };

type Setup = { api: Api; calls: RawCall[]; pushed: Pushed[]; passed: boolean };

const PRIVATE_CHAT_ID = 111;
const GROUP_CHAT_ID = -100111;

// Ответ Telegram подставляется transformer'ом клиента grammY: до сети вызов не доходит, а
// всё, что выше transformer'а, — настоящий Api.
async function setup(fail = false): Promise<Setup> {
    const calls: RawCall[] = [];
    const pushed: Pushed[] = [];

    const api = new Api("test-token");
    const transformer: Transformer<RawApi> = async (_prev, method, payload, signal) => {
        calls.push({ method: method, payload: payload, signal: signal });

        const response = fail ? { ok: false, error_code: 400, description: "Bad Request" } : { ok: true, result: `${method} result` };

        return response as never;
    };
    api.config.use(transformer);

    const taskQueue = {
        push: (task: Task, priority: Priority): void => {
            pushed.push({ task: task, priority: priority });
        },
    } as unknown as TaskQueue;

    const composer = new Composer<Context>();
    new TelegramCallApiMiddleware(taskQueue).setup(composer);

    let passed = false;
    await composer.middleware()({ api: api } as Context, async () => {
        passed = true;
    });

    return { api: api, calls: calls, pushed: pushed, passed: passed };
}

describe("TelegramCallApiMiddleware", function () {
    it("passes the update down", async function () {
        expect((await setup()).passed).to.equal(true);
    });

    describe("a call to a chat", function () {
        it("goes to the queue instead of Telegram", async function () {
            const { api, calls, pushed } = await setup();

            void api.sendMessage(PRIVATE_CHAT_ID, "text");

            expect(calls).to.have.lengthOf(0);
            expect(pushed).to.have.lengthOf(1);
            expect(pushed[0]?.priority).to.equal(Priority.MEDIUM);
            expect(pushed[0]?.task.key).to.equal(PRIVATE_CHAT_ID);
            expect(pushed[0]?.task.priorityOnError).to.equal(Priority.HIGH);
        });

        it("reaches Telegram and resolves the caller when the task runs", async function () {
            const { api, calls, pushed } = await setup();

            const sent = api.raw.sendMessage({ chat_id: PRIVATE_CHAT_ID, text: "text" });
            await pushed[0]?.task.callback();

            expect(await sent).to.equal("sendMessage result");
            expect(calls).to.deep.equal([
                { method: "sendMessage", payload: { chat_id: PRIVATE_CHAT_ID, text: "text" }, signal: undefined },
            ]);
        });

        // Отказ получают обе стороны: вызывающая — сразу, брокер — для бана и повтора.
        it("rejects both the caller and the task with the Telegram failure", async function () {
            const { api, pushed } = await setup(true);

            const sent = api.sendMessage(PRIVATE_CHAT_ID, "text").then(
                () => undefined,
                (error: unknown) => error,
            );
            const ran = (pushed[0] as Pushed).task.callback().then(
                () => undefined,
                (error: unknown) => error,
            );

            const [callerError, taskError] = await Promise.all([sent, ran]);

            expect(callerError).to.be.instanceOf(GrammyError);
            expect(taskError).to.equal(callerError);
        });

        it("goes to the queue for a group chat outside the group-only methods", async function () {
            const { api, calls, pushed } = await setup();

            void api.sendMessage(GROUP_CHAT_ID, "text");

            expect(calls).to.have.lengthOf(0);
            expect(pushed[0]?.task.key).to.equal(GROUP_CHAT_ID);
        });

        it("goes to the queue for a group-only method in a private chat", async function () {
            const { api, calls, pushed } = await setup();

            void api.sendChatAction(PRIVATE_CHAT_ID, "typing");

            expect(calls).to.have.lengthOf(0);
            expect(pushed).to.have.lengthOf(1);
        });
    });

    describe("goes straight to Telegram", function () {
        async function expectDirect(call: (api: Api) => Promise<unknown>, method: string): Promise<void> {
            const { api, calls, pushed } = await setup();

            expect(await call(api)).to.equal(`${method} result`);
            expect(pushed).to.have.lengthOf(0);
            expect(calls.map((rawCall) => rawCall.method)).to.deep.equal([method]);
        }

        it("without chat_id", async function () {
            await expectDirect((api) => api.getFile("file-id"), "getFile");
        });

        it("with a chat_id that is not a number", async function () {
            await expectDirect((api) => api.sendMessage("@channel", "text"), "sendMessage");
        });

        for (const method of ["getChat", "getChatAdministrators", "getChatMembersCount", "getChatMember", "sendChatAction"] as const) {
            it(`for ${method} in a group chat`, async function () {
                const call = (api: Api): Promise<unknown> =>
                    (api.raw[method] as (payload: object) => Promise<unknown>)({ chat_id: GROUP_CHAT_ID });

                await expectDirect(call, method);
            });
        }

        for (const method of ["getMe", "getWebhookInfo"] as const) {
            it(`for ${method}, a method without parameters`, async function () {
                await expectDirect((api) => api[method](), method);
            });
        }

        // grammY зовёт такие методы одним signal, а пустой payload подставляет его собственный raw.
        it("with the signal of a method without parameters in its place", async function () {
            const { api, calls } = await setup();
            // AbortSignal в типах grammY — из шима abort-controller, с глобальным он не сходится.
            const signal = new AbortController().signal as Parameters<Api["getMe"]>[0];

            await api.getMe(signal);

            expect(calls).to.deep.equal([{ method: "getMe", payload: {}, signal: signal }]);
        });

        // Методы grammY строят payload литералом; что построено иначе, в очередь не идёт.
        it("with a payload that is not an object literal", async function () {
            class Payload {
                public readonly chat_id = PRIVATE_CHAT_ID;
                public readonly text = "text";
            }

            await expectDirect((api) => api.raw.sendMessage(new Payload()), "sendMessage");
        });
    });

    // Сериализация ctx.api (например, в лог) не должна превращаться в вызов метода toJSON.
    it("answers toJSON like the raw API of grammY, without a Telegram call", async function () {
        const { api, calls, pushed } = await setup();

        const toJson = (api.raw as unknown as { toJSON: unknown }).toJSON;

        expect(toJson).to.equal((new Api("test-token").raw as unknown as { toJSON: unknown }).toJSON);
        expect(calls).to.have.lengthOf(0);
        expect(pushed).to.have.lengthOf(0);
    });
});
