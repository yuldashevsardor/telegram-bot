// The single dictionary of DI tokens. It lies in shared/ and not in bootstrap/container/: no module
// should go to another module for the name of its own dependency — that is what used to make the
// domain import the registries of the infrastructure.
//
// The string inside Symbol.for is a global key of the process: the same string in different branches
// gives one and the same symbol, and a second bind under it fails the resolve with "Ambiguous
// match". That is why the string is the full path in the dictionary with no separators:
// Tokens.Font.Envelope.Packer → "FontEnvelopePacker". A path is unique in the object, so the string
// is unique too: two joined paths coincide only if one name is split into branches in two ways
// (Bot.UserService next to Bot.User.Service). With such a rule Symbol() would add nothing: the
// dictionary is not loaded twice in a process, and the uniqueness of the strings is already held by
// the path. The string is checked against the path, and the strings against each other, by
// test/shared/tokens.spec.ts.
export const Tokens = {
    Bootstrap: {
        ConfigContainer: Symbol.for("BootstrapConfigContainer"),
        Logger: Symbol.for("BootstrapLogger"),
        RequestContext: Symbol.for("BootstrapRequestContext"),
    },
    Platform: {
        Database: Symbol.for("PlatformDatabase"),
    },
    // The branches inside Font are named after the notions of the subject area (CONTEXT.md): the
    // format signature, the envelope, the conversion engine. A second engine or a second codec of the
    // envelope will lie next to its own notion, and not a single @inject will move because of it.
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
