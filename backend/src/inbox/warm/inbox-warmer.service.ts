import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { MetricsService } from '../../analytics/metrics.service';
import { pool } from '../../shared/async/pool';
import { getEnvConfig } from '../../shared/configs/env-configs';
import { InboxWarmTarget, UserReadService } from '../../user/read/user-read.service';
import { buildFiltersOf } from '../core/entities/inbox-filters.interface';
import { InboxRefreshService } from '../inbox-refresh.service';

/**
 * How long after boot the first sweep runs.
 *
 * There is one at all because without it a deploy leaves every inbox cold for a whole interval -
 * and the first load after a deploy is precisely the case this feature exists to fix. The
 * snapshots live in this process, so they go with it.
 *
 * Twenty seconds because a container that has just started is answering its first requests,
 * opening its first Mongo connections and being health-checked, and firing every GitHub query
 * proke owes into that is a self-inflicted cold start.
 */
const FIRST_SWEEP_DELAY_MS = 20_000;

/**
 * How many users are refreshed at once.
 *
 * Four because the ceiling on this is not GitHub - each query is against the user's own
 * 5,000-an-hour budget - it is this process. Every refresh parses a large GraphQL response and
 * classifies it, which is synchronous work on the same event loop serving webhooks, and
 * `proke.event_loop.delay` is the metric that would show it going wrong.
 */
const CONCURRENCY = 4;

/**
 * How recently somebody must have asked for their inbox for it to be kept ready.
 *
 * Read against `inboxLastUsedAt`, which POST /inbox/refresh stamps, rather than against
 * `lastActivityDate`, which any request does. The difference is everybody who uses proke for
 * pokes and never opens the inbox: gated on activity alone they would cost a GitHub query every
 * five minutes, for ever, for a page they do not look at.
 *
 * Forty-eight hours covers a working week and deliberately not a weekend - somebody who stops on
 * Friday evening and returns on Monday morning arrives to a cold inbox, which costs them about a
 * second and a half once. Their settings are not forgotten while they are away, only left
 * unswept, so the first refresh they make warms them again for the next two days.
 */
const ACTIVE_WITHIN_MS = 48 * 60 * 60_000;

/**
 * Rebuilds everybody's inbox on a timer, under the settings they have stored.
 *
 * ## What it is and is not
 *
 * It calls `InboxRefreshService.refresh` and nothing else - the same code path the endpoint
 * takes, with a timer for a trigger instead of a request. Which is why that service was written
 * as the only thing in the module that talks to GitHub: there is no second implementation of an
 * inbox here to drift from the first.
 *
 * It does not make the client's own refresh unnecessary, and is not meant to. The page still
 * asks GitHub behind rows that are already on screen. What this buys is that the rows are
 * *there* for the first frame - after a deploy and after a night away, which are the two cases
 * where otherwise they are not.
 *
 * ## Why there is nothing to configure
 *
 * There used to be: a list of views per person, pinned by hand. That asked people to predict
 * which settings they would want ready, which is a question nobody has an answer to, and it
 * warmed nothing for the majority who never pressed the button. Now the thing warmed is the
 * thing the page will open on - the settings on the user row - and the only decision left is
 * whether somebody has been here lately, which is made by Mongo in the query.
 *
 * ## Why a plain timer, and why no leader election
 *
 * A timer because two services in this codebase already do exactly this and a dependency for one
 * `setInterval` is not worth its own line in the lockfile. `unref`, like both of them, or the
 * timer alone keeps the process - and every jest run - alive.
 *
 * No leader election because the thing being warmed is a cache inside this process. A second
 * replica warming its own is correct rather than duplicated work; there is nothing shared to
 * coordinate over - the sweep reads Mongo and never writes it. The cost is that GitHub calls
 * multiply by replica count, which is worth knowing before scaling out and is not a reason to
 * coordinate.
 *
 * ## What it is careful about
 *
 * A sweep that overruns its interval must not have another started on top of it, so there is a
 * re-entrancy guard and a counter that says when it fires. And nothing may throw out of the
 * timer callback: an unhandled rejection there takes the process down, and a warm cache is never
 * worth that.
 */
@Injectable()
export class InboxWarmerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InboxWarmerService.name);
  private firstSweep?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly userReadService: UserReadService,
    private readonly inboxRefreshService: InboxRefreshService,
    private readonly metrics: MetricsService,
  ) {}

  public onApplicationBootstrap(): void {
    const intervalMs = getEnvConfig().inbox.warmSweepIntervalMs;

    // Nought is off, which is what the e2e suite wants: a timer reaching for GitHub in the
    // background would make every spec's mocks a race. Specs call `sweep` directly instead.
    if (intervalMs <= 0) {
      this.logger.log('Inbox warming is off (INBOX_WARM_SWEEP_INTERVAL_MS is 0)');
      return;
    }

    this.firstSweep = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS);
    this.firstSweep.unref?.();

    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();

    this.logger.log(`Inbox warming every ${Math.round(intervalMs / 1000)}s`);
  }

  public onModuleDestroy(): void {
    clearTimeout(this.firstSweep);
    clearInterval(this.timer);
  }

  /**
   * One pass over everybody who has been here lately.
   *
   * Public so a spec can drive it without a timer, and so the shape under test is the shape that
   * ships. It resolves rather than rejects whatever happens inside it - see the note above.
   */
  public async sweep(): Promise<void> {
    if (this.sweeping) {
      // Worth counting rather than only logging: a sweep that cannot finish inside its own
      // interval is the failure mode this feature has, and it is invisible in a duration chart
      // because the overrunning sweep is the one that never records.
      this.metrics.count('proke.inbox.warm.sweeps', { outcome: 'overlapped' });
      this.logger.warn('Skipping an inbox warm sweep: the previous one is still running');

      return;
    }

    this.sweeping = true;
    const startedAt = Date.now();

    try {
      await this.run();
      this.metrics.count('proke.inbox.warm.sweeps', { outcome: 'completed' });
    } catch (error) {
      this.metrics.count('proke.inbox.warm.sweeps', { outcome: 'failed' });
      this.logger.error(`Inbox warm sweep failed: ${describe(error)}`);
    } finally {
      this.sweeping = false;
      this.metrics.duration('proke.inbox.warm.duration', Date.now() - startedAt, {});
    }
  }

  private async run(): Promise<void> {
    /*
     * Who is due, decided by Mongo rather than here: asked for their inbox lately and still
     * holding a token. One query, projected down to an id and a settings object, so no stored
     * token is decrypted to answer a question about a date.
     */
    const due = await this.userReadService.readInboxWarmTargets(
      new Date(Date.now() - ACTIVE_WITHIN_MS),
    );

    await pool(due, CONCURRENCY, (target) => this.warm(target));
  }

  /**
   * One person's inbox, under the build half of their settings.
   *
   * Only the build half, because that is what a snapshot is filed under - see
   * InboxStoreService. The view half is applied to the stored document on the way out, so
   * warming one build key makes every reading of it instant.
   */
  private async warm(target: InboxWarmTarget): Promise<void> {
    try {
      const result = await this.inboxRefreshService.refresh(
        target.userId,
        buildFiltersOf(target.settings),
      );

      this.metrics.count('proke.inbox.warmed', {
        result: result.ok
          ? 'refreshed'
          : result.reason === 'no-token'
            ? 'no_token'
            : 'github_unavailable',
      });
    } catch (error) {
      // One person's inbox failing must not end the sweep for everybody behind them in the
      // pool. Logged rather than swallowed silently, because this is the branch that means a
      // bug rather than GitHub being GitHub - `refresh` handles that itself and returns.
      this.metrics.count('proke.inbox.warmed', { result: 'failed' });
      this.logger.error(`Failed to warm the inbox of user ${target.userId}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
