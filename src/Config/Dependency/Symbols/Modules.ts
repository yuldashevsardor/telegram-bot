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
            BulkMessages: Symbol.for("BulkMessages"),
            FontGenerator: Symbol.for("FontGenerator"),
        },
        Middleware: {
            ResponseTime: Symbol.for("ResponseTime"),
        },
    },
};
