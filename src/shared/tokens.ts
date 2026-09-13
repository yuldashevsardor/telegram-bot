// Единый словарь токенов DI. Лежит в shared/, а не в bootstrap/container/: за именем
// собственной зависимости ни один модуль не должен ходить в чужой модуль — раньше из-за этого
// домен импортировал реестры инфраструктуры.
//
// Строка внутри Symbol.for — глобальный ключ процесса: одинаковая строка в разных ветках
// даст один и тот же символ, и второй bind под ним свалит резолв «Ambiguous match».
// Поэтому строка — полный путь в словаре без разделителей: Tokens.Font.Envelope.Packer →
// "FontEnvelopePacker". Путь уникален в объекте, значит, и строка: склейка совпадёт, только
// если одно имя разбить на ветки двумя способами (Bot.UserService рядом с Bot.User.Service).
// С таким правилом Symbol() ничего не добавил бы: второй загрузки словаря в процессе нет,
// а уникальность строк уже держит путь. Сверку строки с путём и попарное несовпадение строк
// делает test/shared/tokens.spec.ts.
export const Tokens = {
    Bootstrap: {
        ConfigContainer: Symbol.for("BootstrapConfigContainer"),
        Logger: Symbol.for("BootstrapLogger"),
        RequestContext: Symbol.for("BootstrapRequestContext"),
    },
    Platform: {
        Database: Symbol.for("PlatformDatabase"),
    },
    // Ветки внутри Font названы понятиями предметной области (CONTEXT.md): «Сигнатура
    // формата», «Конверт», «Движок конвертации». Второй движок или второй кодек конверта
    // лягут рядом со своим понятием, и ни один @inject от этого не поедет.
    Font: {
        Convertor: {
            Convertor: Symbol.for("FontConvertorConvertor"),
            Factory: Symbol.for("FontConvertorFactory"),
        },
        Signature: {
            Matcher: Symbol.for("FontSignatureMatcher"),
        },
        Envelope: {
            Packer: Symbol.for("FontEnvelopePacker"),
        },
        Engine: {
            FontForge: Symbol.for("FontEngineFontForge"),
        },
    },
    Bot: {
        Bot: Symbol.for("BotBot"),
        OutboundQueue: {
            TaskQueue: Symbol.for("BotOutboundQueueTaskQueue"),
            LimitResolver: Symbol.for("BotOutboundQueueLimitResolver"),
            Runner: Symbol.for("BotOutboundQueueRunner"),
        },
        User: {
            Service: Symbol.for("BotUserService"),
            Repository: Symbol.for("BotUserRepository"),
        },
        Command: {
            Start: Symbol.for("BotCommandStart"),
            BulkMessages: Symbol.for("BotCommandBulkMessages"),
            FontGenerator: Symbol.for("BotCommandFontGenerator"),
        },
        Filter: {
            HasSessionKey: Symbol.for("BotFilterHasSessionKey"),
            IsPrivateChat: Symbol.for("BotFilterIsPrivateChat"),
        },
        Middleware: {
            Mutation: {
                TelegramCallApi: Symbol.for("BotMiddlewareMutationTelegramCallApi"),
            },
            RequestContext: Symbol.for("BotMiddlewareRequestContext"),
            ResponseTime: Symbol.for("BotMiddlewareResponseTime"),
            RequestLog: Symbol.for("BotMiddlewareRequestLog"),
            FillUserToContext: Symbol.for("BotMiddlewareFillUserToContext"),
        },
        Conversations: {
            Start: Symbol.for("BotConversationsStart"),
        },
        Session: {
            Storage: Symbol.for("BotSessionStorage"),
        },
    },
};
