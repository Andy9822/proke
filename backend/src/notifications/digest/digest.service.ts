import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { MetricsService } from '../../analytics/metrics.service';
import { buildFiltersOf } from '../../inbox/core/entities/inbox-filters.interface';
import { InboxPullRequest } from '../../inbox/core/entities/inbox.interface';
import { groupWaitingOnYou } from '../../inbox/inbox-classifier';
import { InboxRefreshService } from '../../inbox/inbox-refresh.service';
import { pool } from '../../shared/async/pool';
import { getEnvConfig } from '../../shared/configs/env-configs';
import { localMomentIn } from '../../shared/time/local-day';
import { DigestTarget, UserReadService } from '../../user/read/user-read.service';
import { UserWriteService } from '../../user/write/user-write.service';
import { SlackNotificationDeliveryService } from '../delivery/slack-notification-delivery.service';
import { DigestPullRequest } from '../delivery/slack-message';

/** Without it, a deploy during somebody's digest hour holds their digest until the next sweep. */
const FIRST_SWEEP_DELAY_MS = 20_000;

/** As many at once as the warmer allows itself, and for the same reason: see InboxWarmerService. */
const CONCURRENCY = 4;

/**
 * The daily list of what is still waiting on somebody.
 *
 * The warmer only reads. This sends Slack messages, which cannot be taken back, so a day is
 * claimed and only the pass that wins it posts. See UserWriteService.claimDigest.
 */
@Injectable()
export class DigestService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DigestService.name);
  private firstSweep?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly userReadService: UserReadService,
    private readonly userWriteService: UserWriteService,
    private readonly inboxRefreshService: InboxRefreshService,
    private readonly deliveryService: SlackNotificationDeliveryService,
    private readonly metrics: MetricsService,
  ) {}

  public onApplicationBootstrap(): void {
    const intervalMs = getEnvConfig().notifications.digestSweepIntervalMs;

    if (intervalMs <= 0) {
      this.logger.log('The digest is off (DIGEST_SWEEP_INTERVAL_MS is 0)');

      return;
    }

    this.firstSweep = setTimeout(() => void this.sweep(), FIRST_SWEEP_DELAY_MS);
    this.firstSweep.unref?.();

    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();

    this.logger.log(`Digest sweep every ${Math.round(intervalMs / 60_000)}m`);
  }

  public onModuleDestroy(): void {
    clearTimeout(this.firstSweep);
    clearInterval(this.timer);
  }

  /** `now` is passed so a spec can pin the clock and test two timezones at one instant. */
  public async sweep(now: Date = new Date()): Promise<void> {
    if (this.sweeping) {
      this.metrics.count('proke.digest.sweeps', { outcome: 'overlapped' });
      this.logger.warn('Skipping a digest sweep: the previous one is still running');

      return;
    }

    this.sweeping = true;
    const startedAt = Date.now();

    try {
      const targets = await this.userReadService.readDigestTargets();

      await pool(
        targets.filter((target) => isDue(target, now)),
        CONCURRENCY,
        (target) => this.send(target, now),
      );

      this.metrics.count('proke.digest.sweeps', { outcome: 'completed' });
    } catch (error) {
      this.metrics.count('proke.digest.sweeps', { outcome: 'failed' });
      this.logger.error(`Digest sweep failed: ${describe(error)}`);
    } finally {
      this.sweeping = false;
      this.metrics.duration('proke.digest.duration', Date.now() - startedAt, {});
    }
  }

  private async send(target: DigestTarget, now: Date): Promise<void> {
    try {
      const result = await this.inboxRefreshService.refresh(
        target.userId,
        buildFiltersOf(target.settings),
      );

      // Unclaimed, so a GitHub blip at nine costs one sweep rather than the whole day.
      if (!result.ok) {
        this.metrics.count('proke.digest.sent', {
          outcome: result.reason === 'no-token' ? 'no_token' : 'github_unavailable',
        });

        return;
      }

      // Through the grouping, not the stored rows: ignoredAuthors is applied on the way out.
      const waiting = groupWaitingOnYou(result.snapshot.waitingOnYou, target.settings)
        .flatMap((section) => section.pullRequests)
        .sort(byOldestFirst);

      const day = localMomentIn(target.timezone, now).day;

      if (!(await this.userWriteService.claimDigest(target.userId, day))) {
        this.metrics.count('proke.digest.sent', { outcome: 'claimed_already' });

        return;
      }

      // Below the claim, so a quiet day is spent rather than rebuilt every quarter of an hour.
      if (waiting.length === 0) {
        this.metrics.count('proke.digest.sent', { outcome: 'empty' });

        return;
      }

      const outcome = await this.deliveryService.deliverDigest(
        target.userId,
        waiting.map(toDigestPullRequest),
        now,
      );

      this.metrics.count('proke.digest.sent', {
        outcome: outcome === 'sent' ? 'sent' : outcome === 'failed' ? 'failed' : 'undeliverable',
      });
    } catch (error) {
      this.metrics.count('proke.digest.sent', { outcome: 'failed' });
      this.logger.error(`Failed to send the digest of user ${target.userId}: ${describe(error)}`);
    }
  }
}

/** `sentOn` is checked here, not left to the claim, so the rest of the day costs no writes. */
function isDue(target: DigestTarget, now: Date): boolean {
  const moment = localMomentIn(target.timezone, now);

  return moment.hour >= target.hour && target.sentOn !== moment.day;
}

function byOldestFirst(left: InboxPullRequest, right: InboxPullRequest): number {
  return openedMs(left) - openedMs(right);
}

/** Zero rather than NaN, which would leave the whole list unordered. Same as `updatedMs`. */
function openedMs(pullRequest: InboxPullRequest): number {
  const parsed = Date.parse(pullRequest.createdAt || '');

  return Number.isNaN(parsed) ? 0 : parsed;
}

function toDigestPullRequest(pullRequest: InboxPullRequest): DigestPullRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    repositoryFullName: pullRequest.repositoryFullName,
    authorLogin: pullRequest.author.login,
    createdAt: pullRequest.createdAt,
    changedFiles: pullRequest.changedFiles,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
