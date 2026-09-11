import { Injectable, Logger } from '@nestjs/common';
import { PokeTrigger } from '../../analytics/analytics-events';
import { AnalyticsService } from '../../analytics/analytics.service';
import { MetricsService } from '../../analytics/metrics.service';
import {
  SLACK_DEAD_LINK_CODES,
  SLACK_DEAD_WORKSPACE_CODES,
  SlackApiError,
  SlackApiService,
  SlackMessage,
  SlackMessageRef,
} from '../../slack/app/slack-api.service';
import { SlackLinkNormalized } from '../../slack/links/core/entities/slack-link.interface';
import { SlackLinkReadService } from '../../slack/links/read/slack-link-read.service';
import { SlackLinkWriteService } from '../../slack/links/write/slack-link-write.service';
import { SlackWorkspaceReadService } from '../../slack/workspaces/read/slack-workspace-read.service';
import { SlackWorkspaceWriteService } from '../../slack/workspaces/write/slack-workspace-write.service';
import { UserNormalized } from '../../user/core/entities/user.interface';
import { GithubNotificationNormalized } from '../core/entities/github-notification.interface';
import { NotificationType } from '../core/entities/notification-type.enum';
import { PokeMessageWriteService } from '../messages/write/poke-message-write.service';
import {
  buildDigestMessage,
  buildPokeMessage,
  buildTestMessage,
  buildWelcomeMessage,
  DigestPullRequest,
} from './slack-message';

/**
 * Why a poke did not reach Slack. Only `sent` and `failed` are unusual; the rest are ordinary
 * states for a user who has not finished connecting, and are not worth an error.
 */
export type SlackDeliveryOutcome =
  'sent' | 'no-link' | 'workspace-missing' | 'unreachable' | 'failed';

/*
 * Both lists now live beside SlackApiError, which is where the codes come from. They were here
 * first; they moved because SlackApiService also has to read a code to record what happened, and
 * a second copy would eventually disagree with this one about what a dead workspace is.
 */

/**
 * What a Slack message was, for analytics only.
 *
 * Separate from SlackMessage on purpose: that is what the user reads, this is what we count.
 * Threading it through `send` rather than deriving it from the rendered message means the one
 * choke point every Slack message passes through can describe every message honestly - a test
 * poke is not a notification and should never be counted as one.
 */
interface PokeContext {
  trigger: PokeTrigger;
  /** A NotificationType for real pokes; `test` or `welcome` for the two synthetic ones. */
  pokeType: string;
  /** owner/name. Absent on the synthetic messages, which come from no repository. */
  repository?: string;
  actorLogin?: string;
  reviewState?: string;
  hasExcerpt?: boolean;
  /**
   * How many comments this one message stood for. Without it a review folded into a single poke
   * is indistinguishable from a review that only ever had one comment, and the whole point of
   * the folding - how many messages it saved somebody - cannot be measured.
   */
  commentCount?: number;
}

/**
 * What one attempt came to. The address is present only on a message that actually landed and
 * that Slack told us where it put - it is what makes going back and editing the message possible.
 */
interface SendResult {
  outcome: SlackDeliveryOutcome;
  sent?: SlackMessageRef & { teamId: string };
}

/**
 * Puts a poke in front of somebody in Slack.
 *
 * Needs both halves of the model to line up: the link says who this person is inside a
 * workspace, the workspace holds the token allowed to message them there. Either one missing
 * is a normal, quiet outcome - people connect the two ends minutes or days apart.
 *
 * Failures Slack reports are written back rather than only logged. A revoked token or a
 * departed user would otherwise be rediscovered on every single event, forever.
 */
@Injectable()
export class SlackNotificationDeliveryService {
  private readonly logger = new Logger(SlackNotificationDeliveryService.name);

  constructor(
    private readonly linkReadService: SlackLinkReadService,
    private readonly linkWriteService: SlackLinkWriteService,
    private readonly workspaceReadService: SlackWorkspaceReadService,
    private readonly workspaceWriteService: SlackWorkspaceWriteService,
    private readonly slackApiService: SlackApiService,
    private readonly messageWriteService: PokeMessageWriteService,
    private readonly analytics: AnalyticsService,
    private readonly metrics: MetricsService,
  ) {}

  public async deliver(
    user: UserNormalized,
    notification: GithubNotificationNormalized,
  ): Promise<SlackDeliveryOutcome> {
    const { outcome, sent } = await this.send(user.id, buildPokeMessage(notification), {
      trigger: 'github_webhook',
      pokeType: notification.type,
      repository: notification.repositoryFullName,
      actorLogin: notification.actorLogin,
      reviewState: notification.reviewState,
      hasExcerpt: Boolean(notification.excerpt),
      commentCount: notification.comments?.count,
    });

    // Only for a poke that actually landed, and only for one that came from a webhook - the two
    // synthetic messages carry no arrival time because they did not arrive from anywhere.
    //
    // Expect two humps rather than one: a review is held open for the batching window before it
    // goes, so those pokes are five seconds slower by design. That is worth seeing rather than
    // averaging away, which is why this is a histogram and not a mean.
    if (outcome === 'sent' && notification.receivedAt) {
      this.metrics.duration('proke.poke.latency', Date.now() - notification.receivedAt, {
        type: notification.type,
      });
    }

    if (sent) {
      await this.remember(user, notification, sent);
    }

    return outcome;
  }

  /**
   * Files away where a review request landed, so that the review being done can go back and
   * strike it through.
   *
   * Review requests only. Every other poke is news about something that has already happened,
   * and nothing later makes a merge or a comment untrue - a row for one would be something
   * nothing ever reads, kept about somebody's private repository for two days.
   *
   * Failures are swallowed on purpose. The poke arrived; the caller has already been told so,
   * and could do nothing with this anyway.
   */
  private async remember(
    user: UserNormalized,
    notification: GithubNotificationNormalized,
    sent: SlackMessageRef & { teamId: string },
  ): Promise<void> {
    if (notification.type !== NotificationType.ReviewRequested || !notification.number) {
      return;
    }

    try {
      await this.messageWriteService.remember({
        userId: user.id,
        userGithubId: user.githubId,
        teamId: sent.teamId,
        channelId: sent.channelId,
        messageTs: sent.messageTs,
        repositoryFullName: notification.repositoryFullName,
        pullRequestNumber: notification.number,
        notification,
      });
    } catch (error) {
      this.logger.warn(`Could not remember the poke sent to ${user.id}: ${error}`);
    }
  }

  /**
   * The dashboard's test button. Unlike a real poke this one reports why it failed - the whole
   * point is to find out before a real notification is riding on it.
   */
  public async deliverTest(user: UserNormalized): Promise<SlackDeliveryOutcome> {
    const { outcome } = await this.send(
      user.id,
      buildTestMessage(user.githubLogin),
      { trigger: 'test', pokeType: 'test' },
      { rethrow: true },
    );

    return outcome;
  }

  /**
   * The first poke, sent the moment a connection becomes complete rather than when somebody
   * asks for it. Nobody pressed anything here, so unlike the test button a refusal is an
   * outcome to log and move past - the connection itself is stored and fine either way.
   */
  public async deliverWelcome(user: UserNormalized): Promise<SlackDeliveryOutcome> {
    const { outcome } = await this.send(user.id, buildWelcomeMessage(user.githubLogin), {
      trigger: 'welcome',
      pokeType: 'welcome',
    });

    return outcome;
  }

  /**
   * The day's list, from the sweep rather than anything that just happened. Not remembered the
   * way a poke is: a digest is a list, with nothing in it to strike through later.
   */
  public async deliverDigest(
    userId: string,
    pullRequests: DigestPullRequest[],
    now: Date,
  ): Promise<SlackDeliveryOutcome> {
    const { outcome } = await this.send(userId, buildDigestMessage(pullRequests, now), {
      trigger: 'digest',
      pokeType: 'digest',
    });

    return outcome;
  }

  private async send(
    userId: string,
    message: SlackMessage,
    context: PokeContext,
    options: { rethrow?: boolean } = {},
  ): Promise<SendResult> {
    const link = await this.linkReadService.readForUser(userId);

    // No *event* on either of these. They are not failures, they are people who have not
    // finished connecting - and a poke that had nowhere to go says exactly the same thing every
    // time it happens, once per event in every repository they are subscribed to. Whether
    // somebody has connected Slack is a fact about the person, not about each poke.
    //
    // A count is the other half of that argument rather than a contradiction of it. The reason
    // these are not worth an event each is exactly the reason they are worth counting: the
    // question is how much of proke's routing work ends up reaching nobody, and only a number
    // per hour answers it. Which is the whole difference between the two products.
    if (!link) {
      this.delivered(context, 'no-link');
      return { outcome: 'no-link' };
    }

    const workspace = await this.workspaceReadService.readLiveWithToken(link.teamId);

    if (!workspace) {
      this.delivered(context, 'workspace-missing');
      return { outcome: 'workspace-missing' };
    }

    try {
      const reference = await this.post(link, workspace.botToken, message);
      this.record(userId, context, 'poke_sent');
      this.delivered(context, 'sent');

      return {
        outcome: 'sent',
        sent: reference ? { ...reference, teamId: link.teamId } : undefined,
      };
    } catch (error) {
      const outcome = await this.handleFailure(link, error);

      // Only reachable once Slack has actually been asked and said no, which is what separates
      // this from the two quiet returns above. Note that `workspace-missing` means something
      // different down here: not "never installed" but "the bot token was alive until this
      // moment", which is the whole workspace going down and worth every one of these events.
      //
      // Recorded before the rethrow, so the test button's failures are counted like any other
      // rather than disappearing into the exception that reports them.
      this.record(userId, context, 'poke_failed', outcome);
      this.delivered(context, outcome);

      if (options.rethrow) {
        throw error;
      }

      return { outcome };
    }
  }

  /**
   * Every Slack message proke actually attempts, counted in one place.
   *
   * Two event names rather than one with an `outcome` property: an event called "sent" that
   * also means "tried and failed" makes every chart built on it ambiguous, and the number of
   * attempts is just the two added together.
   *
   * The distinct id is the *recipient* - the event is about somebody being poked, not about
   * whoever caused it. That person is `actor_login`, a property.
   */
  private record(
    userId: string,
    context: PokeContext,
    event: 'poke_sent' | 'poke_failed',
    reason?: SlackDeliveryOutcome,
  ): void {
    this.analytics.capture(userId, event, {
      poke_type: context.pokeType,
      trigger: context.trigger,
      repository: context.repository,
      // Split out here rather than in a query: grouping pokes by organisation is the first
      // question anyone asks of this data, and it should not need string surgery in HogQL.
      repository_owner: context.repository?.split('/')[0],
      actor_login: context.actorLogin,
      review_state: context.reviewState,
      has_excerpt: context.hasExcerpt,
      comment_count: context.commentCount,
      reason,
    });
  }

  /**
   * Every attempt to put a message in front of somebody, counted by what came of it.
   *
   * The far end of `proke.poke.dropped`: between them they account for every candidate the
   * router produced, which is what turns "40,000 webhooks and 300 pokes" from a mystery into a
   * chart. One counter with an `outcome` rather than the two event names next door, because
   * unlike an event these are read as proportions of one total and splitting them would mean
   * adding series back together in every query.
   *
   * No `trigger` dimension: `type` already carries `test` and `welcome`, so the two synthetic
   * messages are told apart without a second attribute multiplying the series count.
   */
  private delivered(context: PokeContext, outcome: SlackDeliveryOutcome): void {
    this.metrics.count('proke.poke.delivered', { type: context.pokeType, outcome });
  }

  /**
   * One post, with a single reopen behind it. A cached DM channel is nearly always still good;
   * when it is not, opening a fresh one is cheaper than never noticing.
   */
  private async post(
    link: SlackLinkNormalized,
    botToken: string,
    message: SlackMessage,
  ): Promise<SlackMessageRef | undefined> {
    if (link.dmChannelId) {
      try {
        return await this.slackApiService.postMessage(botToken, link.dmChannelId, message);
      } catch (error) {
        if (!(error instanceof SlackApiError) || error.code !== 'channel_not_found') {
          throw error;
        }

        await this.linkWriteService.clearDmChannel(link.userId, link.teamId);
      }
    }

    const channel = await this.slackApiService.openDirectMessage(botToken, link.slackUserId);
    const reference = await this.slackApiService.postMessage(botToken, channel, message);
    await this.linkWriteService.cacheDmChannel(link.userId, link.teamId, channel);

    return reference;
  }

  private async handleFailure(
    link: SlackLinkNormalized,
    error: unknown,
  ): Promise<SlackDeliveryOutcome> {
    if (!(error instanceof SlackApiError)) {
      this.logger.error(`Slack delivery failed for user ${link.userId}: ${error}`);
      return 'failed';
    }

    if (SLACK_DEAD_WORKSPACE_CODES.includes(error.code)) {
      this.logger.warn(
        `Slack workspace ${link.teamId} rejected our token (${error.code}); marking it revoked`,
      );
      await this.workspaceWriteService.markRevoked(link.teamId);

      return 'workspace-missing';
    }

    if (SLACK_DEAD_LINK_CODES.includes(error.code)) {
      this.logger.warn(
        `Slack user ${link.slackUserId} is unreachable in ${link.teamId} (${error.code}); ` +
          'dropping the link',
      );
      await this.linkWriteService.delete(link.userId, link.teamId);

      return 'unreachable';
    }

    this.logger.error(`Slack delivery failed for user ${link.userId}: ${error.code}`);

    return 'failed';
  }
}
