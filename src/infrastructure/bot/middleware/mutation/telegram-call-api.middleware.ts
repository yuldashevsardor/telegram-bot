import { Middleware } from "app/infrastructure/bot/middleware/middleware";
import { Api, NextFunction, RawApi } from "grammy";
import { Dispatcher } from "app/domain/dispatcher/dispatcher";
import { inject, injectable } from "inversify";
import { Modules } from "app/infrastructure/container/symbols/modules";
import { Context } from "app/infrastructure/bot/bot.types";
import { PRIORITY } from "app/domain/dispatcher/task";
import { ConfigValue } from "app/infrastructure/config/config-value.decorator";
import { Rates } from "app/infrastructure/config/config";

type RawApiMethod = keyof RawApi;
type RawApiPayload = Record<string, unknown>;

const TELEGRAM_NO_GROUP_RATE_LIMIT_SET = new Set<string | symbol>([
    "getChat",
    "getChatAdministrators",
    "getChatMembersCount",
    "getChatMember",
    "sendChatAction",
]);

@injectable()
export class TelegramCallApiMiddleware extends Middleware {
    // Приватный чат это или группа, знает только эта прослойка: Dispatcher получает уже
    // выбранный лимит вместе с задачей.
    @ConfigValue<Rates>("rates")
    private readonly rates!: Rates;

    public constructor(@inject<Dispatcher>(Modules.Dispatcher.Dispatcher) private readonly dispatcher: Dispatcher) {
        super();
    }

    protected handle(ctx: Context, next: NextFunction): Promise<void> {
        this.changeTelegramCallApi(ctx.api);

        return next();
    }

    private changeTelegramCallApi(api: Api): void {
        // Сохраняем старый raw, что бы вызывать в брокере реально отправку
        const originRaw = api.raw;
        const dispatcher = this.dispatcher;
        const rates = this.rates;

        // Готовим ProxyHandler, который будет ставить запросы в ТГ задачами в очередь
        const proxyHandler: ProxyHandler<RawApi> = {
            get: (_target, method) => {
                return method === "toJSON" ? "__internal" : callApi.bind(api, method as RawApiMethod);
            },
        };

        // Методы RawApi различаются типом payload, поэтому обращение по вычисляемому имени
        // не типизируется без приведения: конкретный метод известен только в рантайме.
        function callRawApi(method: RawApiMethod, payload: RawApiPayload, signal: AbortSignal | undefined): Promise<unknown> {
            const call = originRaw[method] as (payload: RawApiPayload, signal?: AbortSignal) => Promise<unknown>;

            return call(payload, signal);
        }

        async function callApi(method: RawApiMethod, payload: RawApiPayload, signal: AbortSignal | undefined): Promise<unknown> {
            if (payload.constructor.name !== "Object" || !("chat_id" in payload)) {
                return callRawApi(method, payload, signal);
            }

            const chatId = Number(payload["chat_id"]);
            const isAllowedGroupMethod = TELEGRAM_NO_GROUP_RATE_LIMIT_SET.has(method);
            const isGroup = chatId < 0;
            if (isNaN(chatId) || (isGroup && isAllowedGroupMethod)) {
                return callRawApi(method, payload, signal);
            }

            // Это хак, который нужен для того что бы получить результат отправки сообщения через очереди.
            // Создаем переменные для резолва и режекта promise
            // Они будут вызваны после того как сообщения отправится успешно или ошибочно
            let messageResolve!: (value: unknown) => void;
            let messageReject!: (reason: unknown) => void;

            // Создаем сам promise, который и будем отдавать в ответе этой функции
            const promise = new Promise<unknown>((resolve, reject) => {
                messageResolve = resolve;
                messageReject = reject;
            });

            const callback = async (): Promise<void> => {
                try {
                    // Ждём фактический вызов: без await наружу ушёл бы ещё не завершённый promise,
                    // и брокер не увидел бы отказа Telegram.
                    messageResolve(await callRawApi(method, payload, signal));
                } catch (error) {
                    // Вызывающая сторона получает отказ сразу, брокер — ту же ошибку для бана и повтора.
                    messageReject(error);

                    throw error;
                }
            };

            dispatcher.push(
                {
                    key: chatId,
                    rate: isGroup ? rates.group : rates.private,
                    priorityOnError: PRIORITY.HIGH,
                    callback: callback,
                },
                PRIORITY.MEDIUM,
            );

            // Возвращаем promise, у которого resolve или reject будут вызваны в методе callback
            return promise;
        }

        // Подменяем RawApi через Proxy на его замену с очередью
        (api as unknown as { raw: RawApi }).raw = new Proxy(originRaw, proxyHandler);
    }
}
