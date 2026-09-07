export const Modules = {
    TaskQueue: {
        TaskQueue: Symbol.for("TaskQueue"),
        LimitResolver: Symbol.for("LimitResolver"),
        Runner: Symbol.for("Runner"),
    },
    Bot: {
        Bot: Symbol.for("Bot"),
        Command: {
            Start: Symbol.for("Start"),
            BulkMessages: Symbol.for("BulkMessages"),
            FontGenerator: Symbol.for("FontGenerator"),
        },
        Filter: {
            IsPrivateChat: Symbol.for("IsPrivateChat"),
        },
        Middleware: {
            Mutation: {
                TelegramCallApi: Symbol.for("TelegramCallApi"),
            },
            AsyncLocalStorage: Symbol.for("AsyncLocalStorage"),
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
