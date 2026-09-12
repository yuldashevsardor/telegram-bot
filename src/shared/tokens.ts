// Единый словарь токенов DI. Лежит в shared/, а не в bootstrap/container/: за именем
// собственной зависимости ни один модуль не должен ходить в чужой модуль — раньше из-за этого
// домен импортировал реестры инфраструктуры.
//
// Строка внутри Symbol.for — глобальный ключ процесса: одинаковая строка в разных ветках
// даст один и тот же символ, и второй bind под ним свалит резолв «Ambiguous match».
// Поэтому ветки здесь только группируют имена, уникальность держат сами строки.
export const Tokens = {
    Bootstrap: {
        ConfigContainer: Symbol.for("ConfigContainer"),
        Logger: Symbol.for("Logger"),
        RequestContext: Symbol.for("RequestContext"),
    },
    Platform: {
        Database: Symbol.for("Database"),
    },
    // Ветки внутри Font названы понятиями предметной области (CONTEXT.md): «Сигнатура
    // формата», «Конверт», «Движок конвертации». Второй движок или второй кодек конверта
    // лягут рядом со своим понятием, и ни один @inject от этого не поедет.
    Font: {
        Convertor: {
            Convertor: Symbol.for("FontConvertor"),
            Factory: Symbol.for("ConvertorFactory"),
        },
        Signature: {
            Matcher: Symbol.for("FontSignatureMatcher"),
        },
        Envelope: {
            Packer: Symbol.for("EotPacker"),
        },
        Engine: {
            FontForge: Symbol.for("FontForge"),
        },
    },
    Bot: {
        Bot: Symbol.for("Bot"),
        OutboundQueue: {
            TaskQueue: Symbol.for("TaskQueue"),
            LimitResolver: Symbol.for("LimitResolver"),
            Runner: Symbol.for("Runner"),
        },
        User: {
            Service: Symbol.for("UserService"),
            Repository: Symbol.for("UserRepository"),
        },
        Command: {
            Start: Symbol.for("Start"),
            BulkMessages: Symbol.for("BulkMessages"),
            FontGenerator: Symbol.for("FontGenerator"),
        },
        Filter: {
            HasSessionKey: Symbol.for("HasSessionKey"),
            IsPrivateChat: Symbol.for("IsPrivateChat"),
        },
        Middleware: {
            Mutation: {
                TelegramCallApi: Symbol.for("TelegramCallApi"),
            },
            RequestContext: Symbol.for("RequestContextMiddleware"),
            ResponseTime: Symbol.for("ResponseTime"),
            RequestLog: Symbol.for("RequestLog"),
            FillUserToContext: Symbol.for("FillUserToContext"),
        },
        Conversations: {
            Start: Symbol.for("StartConversation"),
        },
        Session: {
            Storage: Symbol.for("SessionStorage"),
        },
    },
};
