import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthCoreModule } from './auth/core/auth-core.module';
import { ConnectionsModule } from './connections/connections.module';
import { InboxModule } from './inbox/inbox.module';
import { InboxWarmModule } from './inbox/warm/inbox-warm.module';
import { DigestModule } from './notifications/digest/digest.module';
import { PokeSettingsModule } from './notifications/settings/poke-settings.module';
import { getEnvConfig } from './shared/configs/env-configs';
import { HttpMetricsModule } from './shared/http/http-metrics.middleware';
import { PosthogLogger } from './shared/logging/posthog-logger';
import { SlackModule } from './slack/slack.module';
import { UserCoreModule } from './user/core/user-core.module';
import { GithubWebhookModule } from './webhooks/github/github-webhook.module';
import { SlackEventsModule } from './webhooks/slack/slack-events.module';

@Module({
  imports: [
    MongooseModule.forRoot(getEnvConfig().mongo.url),
    // Global, so everything below can capture without importing it. See analytics.module.ts.
    AnalyticsModule,
    // Times every request. Brings its own middleware wiring, so this import is the whole of it.
    HttpMetricsModule,
    AuthCoreModule,
    UserCoreModule,
    ConnectionsModule,
    InboxModule,
    // The scheduler InboxModule's export comment refers to.
    InboxWarmModule,
    // What kinds of poke somebody wants, account-wide. The delivery side of notifications is
    // wired in under the webhook module; this is only the settings route.
    PokeSettingsModule,
    // The other scheduler: the daily list of what is still waiting on somebody.
    DigestModule,
    SlackModule,
    GithubWebhookModule,
    SlackEventsModule,
  ],
  // A provider rather than a plain `new` in main.ts, so enableShutdownHooks() reaches it and
  // the last batch of log lines survives a redeploy's SIGTERM.
  providers: [PosthogLogger],
})
export class AppModule {}
