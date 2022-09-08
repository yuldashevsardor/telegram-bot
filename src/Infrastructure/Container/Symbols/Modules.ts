export const Modules = {
    Broker: {
        Broker: Symbol.for("Broker"),
    },
    Planner: {
        Planner: Symbol.for("Planner"),
    },
    Bot: {
        Bot: Symbol.for("Bot"),
        Command: {
            Start: Symbol.for("Start"),
            BulkMessages: Symbol.for("BulkMessages"),
            FontGenerator: Symbol.for("FontGenerator"),
        },
        Middleware: {
            ChangeTelegramCallApi: Symbol.for("ChangeTelegramCallApiMiddleware"),
            AsyncLocalStorage: Symbol.for("AsyncLocalStorage"),
            ResponseTime: Symbol.for("ResponseTime"),
            RequestLog: Symbol.for("RequestLog"),
            OnlyPrivateChat: Symbol.for("OnlyPrivateChat"),
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
