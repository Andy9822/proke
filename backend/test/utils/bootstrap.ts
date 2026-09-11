import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model } from 'mongoose';
import * as nock from 'nock';
import { AnalyticsModule } from '../../src/analytics/analytics.module';
import { AuthCoreModule } from '../../src/auth/core/auth-core.module';
import { RefreshTokenEntity } from '../../src/auth/session/entities/refresh-token.entity';
import { ConnectionsModule } from '../../src/connections/connections.module';
import { InboxModule } from '../../src/inbox/inbox.module';
import { InboxWarmModule } from '../../src/inbox/warm/inbox-warm.module';
import { DigestModule } from '../../src/notifications/digest/digest.module';
import { DigestService } from '../../src/notifications/digest/digest.service';
import { PokeSettingsModule } from '../../src/notifications/settings/poke-settings.module';
import { InboxWarmerService } from '../../src/inbox/warm/inbox-warmer.service';
import { InstallationEntity } from '../../src/installations/core/entities/installation.entity';
import { PokeMessageEntity } from '../../src/notifications/messages/core/entities/poke-message.entity';
import { NotificationDeliveryService } from '../../src/notifications/delivery/notification-delivery.service';
import { ReviewBatchService } from '../../src/notifications/delivery/review-batch.service';
import { SlackNotificationDeliveryService } from '../../src/notifications/delivery/slack-notification-delivery.service';
import { SlackLinkEntity } from '../../src/slack/links/core/entities/slack-link.entity';
import { SlackModule } from '../../src/slack/slack.module';
import { SlackWorkspaceEntity } from '../../src/slack/workspaces/core/entities/slack-workspace.entity';
import { InMemoryCacheService } from '../../src/shared/cache/in-memory-cache.service';
import { HttpMetricsModule } from '../../src/shared/http/http-metrics.middleware';
import { buildValidationPipe } from '../../src/shared/validation/validation-pipe';
import { SubscriptionEntity } from '../../src/subscriptions/core/entities/subscription.entity';
import { UserEntity } from '../../src/user/core/entities/user.entity';
import { UserCoreModule } from '../../src/user/core/user-core.module';
import { UserReadService } from '../../src/user/read/user-read.service';
import { UserWriteService } from '../../src/user/write/user-write.service';
import { GithubWebhookModule } from '../../src/webhooks/github/github-webhook.module';
import { SlackEventsModule } from '../../src/webhooks/slack/slack-events.module';
import { AuthUtils } from './auth-utils';
import { closeInMemoryMongoServer, rootMongooseTestModule } from './mongo-in-memory-server';

/**
 * A review is held open for a window so its several webhooks arrive as one poke. Five seconds
 * is right in production and would be five seconds of dead time in every spec that sends one -
 * long enough here that two requests comfortably land inside it, and no longer.
 *
 * Set before anything Nest builds, because the window is read once when the service is
 * constructed. `??=` so a spec that wants a different one can still say so first.
 */
process.env.REVIEW_BATCH_WINDOW_MS ??= '150';

/** Off for the reason below, and more so: this timer posts to Slack rather than only reading. */
process.env.DIGEST_SWEEP_INTERVAL_MS ??= '0';

/**
 * No sweeping in the background.
 *
 * The inbox warmer's timer would reach for GitHub while a spec was setting up its mocks, which
 * turns every assertion about what was requested into a race with a five-minute clock. Nought
 * turns the timer off entirely; the warm specs call `sweep()` themselves, which is the shape
 * that method is public for.
 */
process.env.INBOX_WARM_SWEEP_INTERVAL_MS ??= '0';

/**
 * No spec may reach the internet.
 *
 * Without this, anything a spec forgot to mock goes to the real api.github.com: a DNS lookup, a
 * handshake and a 401, seconds at a time, and the suite fails or passes depending on the
 * network. An unmocked call now fails instantly and locally, which is also a fair simulation of
 * GitHub being unreachable - every one of these paths is supposed to survive that.
 *
 * Loopback stays open for the two things that are genuinely local: supertest's ephemeral server
 * and the MongoDB the harness starts.
 */
nock.disableNetConnect();
nock.enableNetConnect((host) => host.startsWith('127.0.0.1') || host.startsWith('localhost'));

export async function createTestApp() {
  const module: TestingModule = await Test.createTestingModule({
    imports: [
      rootMongooseTestModule(),
      // Global in app.module.ts, so it has to be listed here too or every service that
      // captures fails to resolve. With no POSTHOG_API_KEY - which the suite never sets - it
      // provides a client that does nothing, so no spec makes a network call to PostHog.
      AnalyticsModule,
      // Also in app.module.ts. Here so that `http.server.duration` is measured over the same
      // routes the specs already exercise - the metric's whole premise is that it records a
      // templated path rather than one with an installation id in it, and that is an assertion
      // rather than something to take on trust.
      HttpMetricsModule,
      AuthCoreModule,
      UserCoreModule,
      ConnectionsModule,
      InboxModule,
      InboxWarmModule,
      PokeSettingsModule,
      DigestModule,
      SlackModule,
      GithubWebhookModule,
      SlackEventsModule,
    ],
  }).compile();

  // Mirrors main.ts: webhook signature verification reads req.rawBody.
  const app = module.createNestApplication({ rawBody: true });
  // The same builder main.ts uses. Constructing a second pipe here is what let the two drift,
  // and let a production-only coercion bug sit under a green suite.
  app.useGlobalPipes(buildValidationPipe());
  await app.init();

  const userModel: Model<UserEntity> = module.get(getModelToken(UserEntity.name));
  const installationModel: Model<InstallationEntity> = module.get(
    getModelToken(InstallationEntity.name),
  );
  const subscriptionModel: Model<SubscriptionEntity> = module.get(
    getModelToken(SubscriptionEntity.name),
  );
  const slackWorkspaceModel: Model<SlackWorkspaceEntity> = module.get(
    getModelToken(SlackWorkspaceEntity.name),
  );
  const slackLinkModel: Model<SlackLinkEntity> = module.get(getModelToken(SlackLinkEntity.name));
  const refreshTokenModel: Model<RefreshTokenEntity> = module.get(
    getModelToken(RefreshTokenEntity.name),
  );
  const pokeMessageModel: Model<PokeMessageEntity> = module.get(
    getModelToken(PokeMessageEntity.name),
  );
  const inMemoryCacheService = app.get(InMemoryCacheService);

  const clearDatabase = async () => {
    await userModel.deleteMany({});
    await installationModel.deleteMany({});
    await subscriptionModel.deleteMany({});
    await slackWorkspaceModel.deleteMany({});
    await slackLinkModel.deleteMany({});
    await pokeMessageModel.deleteMany({});
    await refreshTokenModel.deleteMany({});
  };

  const beforeEach = async () => {
    await clearDatabase();
    nock.cleanAll();
    // Outlives the database, so without this a team one spec looked up - or an inbox one spec
    // built - is still known in the next.
    inMemoryCacheService.clear();
  };

  const afterAll = async () => {
    await app.close();
    await closeInMemoryMongoServer();
  };

  return {
    app,
    module,
    models: {
      userModel,
      installationModel,
      subscriptionModel,
      slackWorkspaceModel,
      slackLinkModel,
      pokeMessageModel,
      refreshTokenModel,
    },
    services: {
      notificationDeliveryService: app.get(NotificationDeliveryService),
      slackNotificationDeliveryService: app.get(SlackNotificationDeliveryService),
      // So a spec can close the batching window itself rather than sitting through it - and so
      // that "nothing was delivered" can mean it, instead of meaning "not yet".
      reviewBatchService: app.get(ReviewBatchService),
      // So a spec can go through the same paths the app uses - the only way to assert that an
      // encrypted-at-rest token still comes out usable, or that claiming a handle releases it
      // from whoever held it before.
      // So a spec can run one pass of the warmer on demand. The timer is off in the suite - see
      // INBOX_WARM_SWEEP_INTERVAL_MS above - so this is the only thing that makes it sweep.
      inboxWarmerService: app.get(InboxWarmerService),
      // Its sweep takes the instant to run at, so a spec can test two timezones at one instant.
      digestService: app.get(DigestService),
      userReadService: app.get(UserReadService),
      userWriteService: app.get(UserWriteService),
      inMemoryCacheService,
    },
    utils: {
      authUtils: new AuthUtils(app),
    },
    methods: {
      clearDatabase,
      afterAll,
      beforeEach,
    },
  };
}
