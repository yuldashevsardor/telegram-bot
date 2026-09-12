// Единый словарь токенов DI. Лежит в common/, а не в infrastructure/container/: за именем
// собственной зависимости ни один модуль не должен ходить в чужой слой — раньше из-за этого
// домен импортировал реестры инфраструктуры.
//
// Строка внутри Symbol.for — глобальный ключ процесса: одинаковая строка в разных ветках
// даст один и тот же символ, и второй bind под ним свалит резолв «Ambiguous match».
// Поэтому ветки здесь только группируют имена, уникальность держат сами строки.
export const Tokens = {
    Infrastructure: {
        ConfigContainer: Symbol.for("ConfigContainer"),
        Logger: Symbol.for("Logger"),
        RequestContext: Symbol.for("RequestContext"),
        Database: Symbol.for("Database"),
    },
    FontConvertor: {
        FontConvertor: Symbol.for("FontConvertor"),
        ConvertorFactory: Symbol.for("ConvertorFactory"),
        FontForge: Symbol.for("FontForge"),
        FontSignatureMatcher: Symbol.for("FontSignatureMatcher"),
        EotPacker: Symbol.for("EotPacker"),
    },
    TaskQueue: {
        TaskQueue: Symbol.for("TaskQueue"),
        LimitResolver: Symbol.for("LimitResolver"),
        Runner: Symbol.for("Runner"),
    },
    User: {
        UserService: Symbol.for("UserService"),
        UserRepository: Symbol.for("UserRepository"),
    },
    Bot: {
        Bot: Symbol.for("Bot"),
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
