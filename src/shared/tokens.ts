// The single dictionary of DI tokens. It lies in shared/ and not in bootstrap/container/, so that
// no module goes to another for the name of its own dependency. That used to make the domain import
// the registries of the infrastructure.
//
// The string inside Symbol.for is a global key of the process. The same string in any branch gives
// the same symbol, and a second bind under it fails the resolve with "Ambiguous match". So the
// string is the full path with no separators: Tokens.Font.Envelope.Packer → "FontEnvelopePacker".
// The path is unique in the object, and two joined paths coincide only if one name is split into
// branches in two ways (Bot.UserService next to Bot.User.Service). Symbol() would add nothing: the
// dictionary is loaded once per process, and the path already keeps the strings unique.
// test/shared/tokens.spec.ts checks each string against its path, and the strings against each
// other.
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
    // envelope, the conversion engine. `Validator` is the one role among them: the check of a source
    // format by validating the whole file. A second engine or a second codec of the envelope will lie
    // next to its own notion, and not a single @inject will move because of it.
    Font: {
        Convertor: {
            Convertor: Symbol.for("FontConvertorConvertor"),
            Factory: Symbol.for("FontConvertorFactory"),
        },
        Validator: {
            Resolver: Symbol.for("FontValidatorResolver"),
            Svg: Symbol.for("FontValidatorSvg"),
            Sfnt: Symbol.for("FontValidatorSfnt"),
            Woff: Symbol.for("FontValidatorWoff"),
            Woff2: Symbol.for("FontValidatorWoff2"),
            Eot: Symbol.for("FontValidatorEot"),
        },
        Envelope: {
            Packer: Symbol.for("FontEnvelopePacker"),
            PayloadDecoder: Symbol.for("FontEnvelopePayloadDecoder"),
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
        Outbox: {
            Store: Symbol.for("BotOutboxStore"),
            RetryDelay: Symbol.for("BotOutboxRetryDelay"),
            Result: {
                Waiter: Symbol.for("BotOutboxResultWaiter"),
                Reader: Symbol.for("BotOutboxResultReader"),
            },
            FailureHandler: Symbol.for("BotOutboxFailureHandler"),
            Lease: {
                Recovery: Symbol.for("BotOutboxLeaseRecovery"),
                Retrier: Symbol.for("BotOutboxLeaseRetrier"),
                Releaser: Symbol.for("BotOutboxLeaseReleaser"),
            },
            MessageSource: Symbol.for("BotOutboxMessageSource"),
            ErrorSerializer: Symbol.for("BotOutboxErrorSerializer"),
            ApiFactory: Symbol.for("BotOutboxApiFactory"),
            Sender: Symbol.for("BotOutboxSender"),
            MessageProcessor: Symbol.for("BotOutboxMessageProcessor"),
            Runner: Symbol.for("BotOutboxRunner"),
            Maintenance: Symbol.for("BotOutboxMaintenance"),
        },
        Inbox: {
            Store: Symbol.for("BotInboxStore"),
            FailureClassifier: Symbol.for("BotInboxFailureClassifier"),
            FailureHandler: Symbol.for("BotInboxFailureHandler"),
        },
        ApiFailureClassifier: Symbol.for("BotApiFailureClassifier"),
        UnblockCommandLine: Symbol.for("BotUnblockCommandLine"),
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
