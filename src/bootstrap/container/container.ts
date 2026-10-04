import "reflect-metadata";
import { Container as InversifyContainer } from "inversify";
import { Tokens } from "app/shared/tokens";
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import type { CC } from "app/bootstrap/config/container/config-container.types";
import type { RequestContext } from "app/platform/request-context/request-context";
import { FontForge } from "app/font-convertor/font-forge/font-forge";
import { SvgFontValidator } from "app/font-convertor/validator/svg/svg-font-validator";
import { SfntFontValidator } from "app/font-convertor/validator/sfnt/sfnt-font-validator";
import { WoffFontValidator } from "app/font-convertor/validator/woff/woff-font-validator";
import { Woff2FontValidator } from "app/font-convertor/validator/woff2/woff2-font-validator";
import { EotFontValidator } from "app/font-convertor/validator/eot/eot-font-validator";
import { FontValidatorResolver } from "app/font-convertor/validator/font-validator-resolver";
import { EotPacker } from "app/font-convertor/eot-packer/eot-packer";
import { EotPayloadDecoder } from "app/font-convertor/eot-payload-decoder/eot-payload-decoder";
import { ConvertorFactory } from "app/font-convertor/convertor/convertor-factory";
import { FontConvertor } from "app/font-convertor/font-convertor";
import { TaskQueue } from "app/telegram/outbound-queue/task-queue";
import { Runner } from "app/telegram/outbound-queue/runner/runner";
import type { LimitResolver } from "app/telegram/outbound-queue/limit-resolver";
import { TelegramLimitResolver } from "app/telegram/telegram-limit-resolver";
import { Bot } from "app/telegram/bot/bot";
import { BulkMessagesCommand } from "app/telegram/command/bulk-messages/bulk-messages.command";
import { FontGeneratorCommand } from "app/telegram/command/font-generator/font-generator.command";
import type { Logger } from "app/platform/logger/logger";
import { ResponseTimeMiddleware } from "app/telegram/middleware/response-time.middleware";
import { RequestLogMiddleware } from "app/telegram/middleware/request-log.middleware";
import { RequestContextMiddleware } from "app/telegram/middleware/request-context.middleware";
import { IsPrivateChatFilter } from "app/telegram/filter/is-private-chat.filter";
import { HasSessionKeyFilter } from "app/telegram/filter/has-session-key.filter";
import { FillUserToContextMiddleware } from "app/telegram/middleware/fill-user-to-context.middleware";
import { StartCommand } from "app/telegram/command/start/start.command";
import type { StorageAdapter } from "grammy";
import type { SessionPayload } from "app/telegram/session/session.types";
import { PgsqlStorage } from "app/telegram/session/pgsql-storage";
import { Database } from "app/platform/database/database";
import type { UserRepository } from "app/telegram/user/user-repository";
import { PgSqlUserRepository } from "app/telegram/user/pgsql-repository/pgsql-user-repository";
import { UserService } from "app/telegram/user/service/user-service";
import { TelegramCallApiMiddleware } from "app/telegram/middleware/mutation/telegram-call-api.middleware";
import { StartConversation } from "app/telegram/conversation/start/start.conversation";
import { OutboxStore } from "app/telegram/outbox/store/outbox-store";
import { OutboxRetryDelay } from "app/telegram/outbox/retry-delay/outbox-retry-delay";
import { OutboxFinishedMessageReader } from "app/telegram/outbox/outbox-finished-message-reader";
import { OutboxResultWaiter } from "app/telegram/outbox/result-waiter/outbox-result-waiter";
import { OutboxFailureHandler } from "app/telegram/outbox/outbox-failure-handler";
import { OutboxErrorSerializer } from "app/telegram/outbox/outbox-error-serializer";
import { OutboxMessageSource } from "app/telegram/outbox/outbox-message-source";
import { OutboxApiFactory } from "app/telegram/outbox/outbox-api-factory";
import { OutboxSender } from "app/telegram/outbox/outbox-sender";
import { OutboxMessageProcessor } from "app/telegram/outbox/outbox-message-processor";
import { OutboxRunner } from "app/telegram/outbox/outbox-runner";
import { OutboxRetrier } from "app/telegram/outbox/outbox-retrier";
import { OutboxLeaseReleaser } from "app/telegram/outbox/outbox-lease-releaser";
import { OutboxLeaseRecovery } from "app/telegram/outbox/outbox-lease-recovery";
import { OutboxMaintenance } from "app/telegram/outbox/maintenance/outbox-maintenance";
import { InboxStore } from "app/telegram/inbox/store/inbox-store";
import { InboxFailureClassifier } from "app/telegram/inbox/failure-classifier/inbox-failure-classifier";
import { InboxFailureHandler } from "app/telegram/inbox/inbox-failure-handler";
import { TelegramBotApiFailureClassifier } from "app/telegram/bot-api-failure-classifier/telegram-bot-api-failure-classifier";

export class Container extends InversifyContainer {
    private alreadySetup = false;

    // The context is assembled before the container, so everything bound below can already count on
    // its parts.
    public async setup(): Promise<void> {
        if (this.alreadySetup) {
            return;
        }

        await this.setupBootstrap();
        await this.setupFontConvertor();
        await this.setupTelegram();
        await this.setupPlatform();

        this.alreadySetup = true;
    }

    public async close(): Promise<void> {
        if (!this.alreadySetup) {
            return;
        }

        // Before the database: a pending wait would poll the closed pool until its timeout.
        this.get<OutboxResultWaiter>(Tokens.Bot.Outbox.Result.Waiter).stop();
        await this.get<Database>(Tokens.Platform.Database).close();

        // Stryker disable next-line BooleanLiteral: `true` differs only on a repeated close(), where sql.end() hands back the same promise of completion, and on a setup() after close(), which does not work with either value: the container is single-use
        this.alreadySetup = false;
    }

    private async setupBootstrap(): Promise<void> {
        this.bind<CC>(Tokens.Bootstrap.ConfigContainer).toConstantValue(ApplicationContext.getConfigContainer());
        this.bind<Logger>(Tokens.Bootstrap.Logger).toConstantValue(ApplicationContext.getLogger());
        this.bind<RequestContext>(Tokens.Bootstrap.RequestContext).toConstantValue(ApplicationContext.getRequestContext());
    }

    private async setupFontConvertor(): Promise<void> {
        this.bind<ConvertorFactory>(Tokens.Font.Convertor.Factory).to(ConvertorFactory).inSingletonScope();
        this.bind<FontForge>(Tokens.Font.Engine.FontForge).to(FontForge).inSingletonScope();
        this.bind<SvgFontValidator>(Tokens.Font.Validator.Svg).to(SvgFontValidator).inSingletonScope();
        this.bind<SfntFontValidator>(Tokens.Font.Validator.Sfnt).to(SfntFontValidator).inSingletonScope();
        this.bind<WoffFontValidator>(Tokens.Font.Validator.Woff).to(WoffFontValidator).inSingletonScope();
        this.bind<Woff2FontValidator>(Tokens.Font.Validator.Woff2).to(Woff2FontValidator).inSingletonScope();
        this.bind<EotFontValidator>(Tokens.Font.Validator.Eot).to(EotFontValidator).inSingletonScope();
        this.bind<FontValidatorResolver>(Tokens.Font.Validator.Resolver).to(FontValidatorResolver).inSingletonScope();
        this.bind<EotPacker>(Tokens.Font.Envelope.Packer).to(EotPacker).inSingletonScope();
        this.bind<EotPayloadDecoder>(Tokens.Font.Envelope.PayloadDecoder).to(EotPayloadDecoder).inSingletonScope();
        this.bind<FontConvertor>(Tokens.Font.Convertor.Convertor).to(FontConvertor).inSingletonScope();
    }

    private async setupTelegram(): Promise<void> {
        this.bind<Bot>(Tokens.Bot.Bot).to(Bot).inSingletonScope();

        // Outbound queue
        this.bind<LimitResolver>(Tokens.Bot.OutboundQueue.LimitResolver).to(TelegramLimitResolver).inSingletonScope();
        this.bind<TaskQueue>(Tokens.Bot.OutboundQueue.TaskQueue).to(TaskQueue).inSingletonScope();
        this.bind<Runner>(Tokens.Bot.OutboundQueue.Runner).to(Runner).inSingletonScope();

        // Outbox
        this.bind<OutboxStore>(Tokens.Bot.Outbox.Store).to(OutboxStore).inSingletonScope();
        this.bind<OutboxRetryDelay>(Tokens.Bot.Outbox.RetryDelay).to(OutboxRetryDelay).inSingletonScope();
        this.bind<OutboxFinishedMessageReader>(Tokens.Bot.Outbox.Result.Reader).to(OutboxFinishedMessageReader).inSingletonScope();
        this.bind<OutboxResultWaiter>(Tokens.Bot.Outbox.Result.Waiter).to(OutboxResultWaiter).inSingletonScope();
        this.bind<OutboxFailureHandler>(Tokens.Bot.Outbox.FailureHandler).to(OutboxFailureHandler).inSingletonScope();
        this.bind<OutboxRetrier>(Tokens.Bot.Outbox.Retrier).to(OutboxRetrier).inSingletonScope();
        this.bind<OutboxLeaseReleaser>(Tokens.Bot.Outbox.LeaseReleaser).to(OutboxLeaseReleaser).inSingletonScope();
        this.bind<OutboxErrorSerializer>(Tokens.Bot.Outbox.ErrorSerializer).to(OutboxErrorSerializer).inSingletonScope();
        this.bind<OutboxMessageSource>(Tokens.Bot.Outbox.MessageSource).to(OutboxMessageSource).inSingletonScope();
        this.bind<OutboxApiFactory>(Tokens.Bot.Outbox.ApiFactory).to(OutboxApiFactory).inSingletonScope();
        this.bind<OutboxSender>(Tokens.Bot.Outbox.Sender).to(OutboxSender).inSingletonScope();
        this.bind<OutboxMessageProcessor>(Tokens.Bot.Outbox.MessageProcessor).to(OutboxMessageProcessor).inSingletonScope();
        this.bind<OutboxRunner>(Tokens.Bot.Outbox.Runner).to(OutboxRunner).inSingletonScope();
        this.bind<OutboxLeaseRecovery>(Tokens.Bot.Outbox.LeaseRecovery).to(OutboxLeaseRecovery).inSingletonScope();
        this.bind<OutboxMaintenance>(Tokens.Bot.Outbox.Maintenance).to(OutboxMaintenance).inSingletonScope();

        // Inbox
        this.bind<InboxStore>(Tokens.Bot.Inbox.Store).to(InboxStore).inSingletonScope();
        this.bind<InboxFailureClassifier>(Tokens.Bot.Inbox.FailureClassifier).to(InboxFailureClassifier).inSingletonScope();
        this.bind<InboxFailureHandler>(Tokens.Bot.Inbox.FailureHandler).to(InboxFailureHandler).inSingletonScope();

        // Bot API failures
        this.bind<TelegramBotApiFailureClassifier>(Tokens.Bot.ApiFailureClassifier).to(TelegramBotApiFailureClassifier).inSingletonScope();

        // User
        this.bind<UserRepository>(Tokens.Bot.User.Repository).to(PgSqlUserRepository).inSingletonScope();
        this.bind<UserService>(Tokens.Bot.User.Service).to(UserService).inSingletonScope();

        // Filters
        this.bind<HasSessionKeyFilter>(Tokens.Bot.Filter.HasSessionKey).to(HasSessionKeyFilter).inSingletonScope();
        this.bind<IsPrivateChatFilter>(Tokens.Bot.Filter.IsPrivateChat).to(IsPrivateChatFilter).inSingletonScope();

        // Middlewares
        this.bind<TelegramCallApiMiddleware>(Tokens.Bot.Middleware.Mutation.TelegramCallApi)
            .to(TelegramCallApiMiddleware)
            .inSingletonScope();

        this.bind<RequestContextMiddleware>(Tokens.Bot.Middleware.RequestContext).to(RequestContextMiddleware).inSingletonScope();
        this.bind<ResponseTimeMiddleware>(Tokens.Bot.Middleware.ResponseTime).to(ResponseTimeMiddleware).inSingletonScope();
        this.bind<RequestLogMiddleware>(Tokens.Bot.Middleware.RequestLog).to(RequestLogMiddleware).inSingletonScope();
        this.bind<FillUserToContextMiddleware>(Tokens.Bot.Middleware.FillUserToContext).to(FillUserToContextMiddleware).inSingletonScope();

        // Commands
        this.bind<StartCommand>(Tokens.Bot.Command.Start).to(StartCommand).inSingletonScope();
        this.bind<BulkMessagesCommand>(Tokens.Bot.Command.BulkMessages).to(BulkMessagesCommand).inSingletonScope();
        this.bind<FontGeneratorCommand>(Tokens.Bot.Command.FontGenerator).to(FontGeneratorCommand).inSingletonScope();

        // Session
        this.bind<StorageAdapter<SessionPayload>>(Tokens.Bot.Session.Storage).to(PgsqlStorage).inSingletonScope();

        // Conversations
        this.bind<StartConversation>(Tokens.Bot.Conversations.Start).to(StartConversation).inSingletonScope();
    }

    private async setupPlatform(): Promise<void> {
        this.bind<Database>(Tokens.Platform.Database).to(Database).inSingletonScope();
    }
}

export const container = new Container();
