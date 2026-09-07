import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from '../../analytics/analytics.service';
import { SlackApiError, SlackApiService } from '../../slack/app/slack-api.service';
import { SlackWorkspaceReadService } from '../../slack/workspaces/read/slack-workspace-read.service';
import { UserReadService } from '../../user/read/user-read.service';
import {
  GithubReviewVerdict,
  isReviewVerdict,
  PokeRequestedReviewers,
  PokeResolution,
  PokeResolutionKind,
  PokeReviewer,
} from '../core/entities/github-notification.interface';
import { keepsReviewRequestWhileAsked } from '../core/poke-settings';
import {
  PokeMessageNormalized,
  PokeMessageReviewer,
} from '../messages/core/entities/poke-message.interface';
import { PokeMessageReadService } from '../messages/read/poke-message-read.service';
import { PokeMessageWriteService } from '../messages/write/poke-message-write.service';
import { buildPokeMessage } from './slack-message';

/**
 * What happened to the pull request, before we know who it happened to.
 *
 * The actor is by id as well as by handle for the same reason routing is: only the id survives
 * a rename, and the one thing this decides per recipient is whether the actor is them.
 */
export interface PokeResolutionEvent {
  kind: PokeResolutionKind;
  actorGithubId?: string;
  actorLogin?: string;
  /**
   * Who GitHub still lists as asked, once this event has happened.
   *
   * Absent where the answer cannot matter - a merge or a close moots every request - and where
   * the payload did not say. The second reads as nobody still asked, on purpose: a reader who
   * cannot be shown to be on the hook is struck through, which is exactly what every reader got
   * before the strict setting existed.
   */
  requested?: PokeRequestedReviewers;
  /** Whose request this event took away. Set on a removal, and on nothing else. */
  removed?: PokeRemovedRequest;
}

/**
 * One of the two, never both: GitHub removes a person or a team per event, exactly as it asks
 * them. The handle is `org/slug`, lowercased, so it compares to what a poke carries.
 */
export interface PokeRemovedRequest {
  githubId?: string;
  teamHandle?: string;
}

/**
 * Somebody reviewed the pull request and the request stands. The message gains their name.
 *
 * Usually because they decided nothing. Under the strict setting, also because they did and
 * GitHub went on asking the reader anyway - and then the verdict rides along, so the line can
 * say which way it went.
 */
export interface PokeReviewerEvent {
  actorGithubId?: string;
  actorLogin?: string;
  verdict?: GithubReviewVerdict;
}

/** Slack saying the message is not there to edit. The row is pointing at nothing. */
const GONE = ['message_not_found', 'channel_not_found'];

/**
 * Goes back and edits review requests the pull request has moved on from - struck through
 * where it has moved past them, annotated where somebody has merely been there first.
 *
 * The asymmetry with delivery is the point: a poke is sent to one person because something
 * concerned them, but a review is about the pull request, so one review can edit four
 * messages in four different DMs - none of them the reviewer's own.
 *
 * Every failure here is quiet. Nothing is waiting on this, the original poke went out fine, and
 * an edit that did not happen leaves the reader exactly where they were before the feature
 * existed. Rows that could not be edited are dropped or left to expire rather than retried,
 * because the news gets staler than it is worth.
 */
@Injectable()
export class PokeResolutionService {
  private readonly logger = new Logger(PokeResolutionService.name);

  constructor(
    private readonly messageReadService: PokeMessageReadService,
    private readonly messageWriteService: PokeMessageWriteService,
    private readonly workspaceReadService: SlackWorkspaceReadService,
    private readonly userReadService: UserReadService,
    private readonly slackApiService: SlackApiService,
    private readonly analytics: AnalyticsService,
  ) {}

  public async resolve(
    repositoryFullName: string,
    pullRequestNumber: number,
    event: PokeResolutionEvent,
  ): Promise<void> {
    try {
      const messages = await this.messageReadService.readForPullRequest(
        repositoryFullName,
        pullRequestNumber,
      );

      // The common case by a distance: most pull requests never had a review request poke to
      // strike, and every merge in every subscribed repository comes through here.
      if (messages.length === 0) {
        return;
      }

      // A removal is about one person or one team. Everybody else asked about this pull request
      // is left exactly as they were - unlike a verdict, which is about the pull request itself.
      const removed = event.removed;
      const concerned = removed
        ? messages.filter((message) => concerns(message, removed))
        : messages;

      // Concurrently, and one failure must not take the others with it - these are unrelated
      // people in possibly unrelated workspaces who happen to share a pull request.
      await Promise.all(concerned.map((message) => this.settle(message, event)));
    } catch (error) {
      this.logger.error(
        `Could not resolve pokes for ${repositoryFullName}#${pullRequestNumber}: ${error}`,
      );
    }
  }

  /**
   * Names a reviewer under every request still outstanding on the pull request, without
   * settling any of them.
   *
   * Same shape as resolve, same quietness, and the same fan-out - but the rows stay, because the
   * one thing this must not do is stop the strikethrough from landing when a verdict does.
   */
  public async annotate(
    repositoryFullName: string,
    pullRequestNumber: number,
    event: PokeReviewerEvent,
  ): Promise<void> {
    try {
      const messages = await this.messageReadService.readForPullRequest(
        repositoryFullName,
        pullRequestNumber,
      );

      if (messages.length === 0) {
        return;
      }

      await Promise.all(messages.map((message) => this.name(message, event)));
    } catch (error) {
      this.logger.error(
        `Could not annotate pokes for ${repositoryFullName}#${pullRequestNumber}: ${error}`,
      );
    }
  }

  private async settle(message: PokeMessageNormalized, event: PokeResolutionEvent): Promise<void> {
    const bySelf = Boolean(event.actorGithubId) && message.userGithubId === event.actorGithubId;

    // A removal that leaves the reader asked another way - by name after the team was taken
    // off, or through the team after their name was - takes nothing away from them, and the
    // message stays exactly as it is. That is the ordinary sequence wherever a team assigns its
    // reviews: GitHub asks the team, then removes the team and asks some of its members by name.
    if (event.kind === 'removed' && stillRequested(message, event.requested)) {
      return;
    }

    // Somebody else's verdict, under a reader who keeps the request as long as GitHub keeps
    // asking, is news about the pull request rather than the end of the ask - so it goes on the
    // line where reviewers go, verdict and all, and the row stays for whatever ends it.
    if (isReviewVerdict(event.kind) && !bySelf && (await this.keptStanding(message, event))) {
      await this.name(message, {
        actorGithubId: event.actorGithubId,
        actorLogin: event.actorLogin,
        verdict: event.kind,
      });
      return;
    }

    const resolution: PokeResolution = {
      kind: event.kind,
      actorLogin: event.actorLogin,
      bySelf,
    };

    const workspace = await this.workspaceReadService.readLiveWithToken(message.teamId);

    // Uninstalled or revoked since the poke went out. Nothing will ever edit this message, so
    // the row is waiting for a day that cannot come.
    if (!workspace) {
      await this.messageWriteService.delete(message.id);
      return;
    }

    try {
      await this.slackApiService.updateMessage(
        workspace.botToken,
        message.channelId,
        message.messageTs,
        buildPokeMessage(message.notification, { resolution }),
      );

      // Before the row goes, and only once Slack has confirmed the edit - a poke counted as
      // resolved that still reads as outstanding would be the one number here worth having.
      this.analytics.capture(message.userId, 'poke_resolved', {
        resolution: resolution.kind,
        by_self: resolution.bySelf,
        repository: message.repositoryFullName,
        repository_owner: message.repositoryFullName.split('/')[0],
        actor_login: resolution.actorLogin,
      });

      await this.messageWriteService.delete(message.id);
    } catch (error) {
      await this.handleFailure(message, error);
    }
  }

  /**
   * Whether this reader keeps the request while GitHub still asks them - and GitHub still does.
   *
   * GitHub's half first, because it is free and usually the answer: under the default setting
   * the reader's account is never read at all, and under the strict one it is read only while
   * there is something for it to decide. The setting is read live rather than carried on the
   * row the way the GitHub id is: one indexed read per outstanding request, and a switch flipped
   * on the dashboard applies to the pokes already sitting in Slack rather than to the next two
   * days' worth.
   */
  private async keptStanding(
    message: PokeMessageNormalized,
    event: PokeResolutionEvent,
  ): Promise<boolean> {
    if (!stillRequested(message, event.requested)) {
      return false;
    }

    const user = await this.userReadService.readById(message.userId);

    // A row that has outlived its account. Deleting the account removes its rows, so this is a
    // race rather than a state - and the default is the right answer to it, because a message
    // nobody will ever read again is not worth keeping editable.
    return user ? keepsReviewRequestWhileAsked(user.pokeSettings) : false;
  }

  private async name(message: PokeMessageNormalized, event: PokeReviewerEvent): Promise<void> {
    const reviewer: PokeMessageReviewer = {
      githubId: event.actorGithubId,
      login: event.actorLogin,
      verdict: event.verdict,
    };

    // The reader's own comments are not news to the reader. Left off rather than rendered as
    // "you", unlike a verdict, because a verdict changes what the message is and this would
    // only change what it costs.
    if (Boolean(event.actorGithubId) && message.userGithubId === event.actorGithubId) {
      return;
    }

    // Already on the line, saying nothing new: a second review from the same person with no
    // more of a verdict than the first, or the verdict they had already reached. An edit that
    // changes nothing is a Slack call for nothing. A verdict after a comment - or a different
    // verdict - is news, and changes their mark where they stand.
    const known = message.reviewers.find((candidate) => samePerson(candidate, reviewer));

    if (known && (!reviewer.verdict || known.verdict === reviewer.verdict)) {
      return;
    }

    const workspace = await this.workspaceReadService.readLiveWithToken(message.teamId);

    if (!workspace) {
      await this.messageWriteService.delete(message.id);
      return;
    }

    // The row before the message, which is the other way round from settle - and on purpose.
    // The row is what every later edit renders from, so a row that knows about a reviewer the
    // message does not yet is healed by the next edit, whereas a message that knows about one
    // the row does not would lose them the next time anybody else reviewed.
    await this.messageWriteService.addReviewer(message.id, reviewer);

    const reviewers: PokeReviewer[] = (
      known
        ? message.reviewers.map((candidate) =>
            samePerson(candidate, reviewer)
              ? { ...candidate, verdict: reviewer.verdict }
              : candidate,
          )
        : [...message.reviewers, reviewer]
    ).map((candidate) => ({ login: candidate.login, verdict: candidate.verdict }));

    try {
      await this.slackApiService.updateMessage(
        workspace.botToken,
        message.channelId,
        message.messageTs,
        buildPokeMessage(message.notification, { reviewers }),
      );

      this.analytics.capture(message.userId, 'poke_annotated', {
        repository: message.repositoryFullName,
        repository_owner: message.repositoryFullName.split('/')[0],
        actor_login: event.actorLogin,
        reviewer_count: reviewers.length,
        // Which of the two things this was: somebody talking, or a verdict the reader's strict
        // setting kept the request standing through. The second is the one number that says
        // whether anybody needed the setting.
        verdict: event.verdict,
      });
    } catch (error) {
      await this.handleFailure(message, error);
    }
  }

  private async handleFailure(message: PokeMessageNormalized, error: unknown): Promise<void> {
    if (error instanceof SlackApiError && GONE.includes(error.code)) {
      this.logger.debug(
        `Poke ${message.messageTs} is gone from ${message.channelId}; dropping the row`,
      );
      await this.messageWriteService.delete(message.id);

      return;
    }

    // Left in place deliberately. A rate limit or a blip is the one case where the row is still
    // good, and the next thing to happen to this pull request will try again - until the TTL
    // decides the edit stopped being worth applying.
    this.logger.warn(`Could not edit the poke sent to ${message.userId}: ${error}`);
  }
}

/**
 * Whether GitHub still asks this reader for a review, by either route it can: by name, or
 * through the team the poke came in by.
 *
 * Both are checked whatever the poke said, because the two overlap in practice - a team with
 * review assignment on is asked, and then some of its members are asked by name a second later.
 * A reader whose team is off the list but whose name is on it is still asked.
 */
function stillRequested(
  message: PokeMessageNormalized,
  requested: PokeRequestedReviewers | undefined,
): boolean {
  if (!requested) {
    return false;
  }

  if (message.userGithubId && requested.githubIds.includes(message.userGithubId)) {
    return true;
  }

  const team = message.notification.teamHandle?.toLowerCase();

  return team !== undefined && requested.teamHandles.includes(team);
}

/** Whether a removal was of this reader's request: their name, or the team their poke named. */
function concerns(message: PokeMessageNormalized, removed: PokeRemovedRequest): boolean {
  if (removed.githubId) {
    return message.userGithubId === removed.githubId;
  }

  if (removed.teamHandle) {
    return message.notification.teamHandle?.toLowerCase() === removed.teamHandle;
  }

  return false;
}

/**
 * Whether two reviewers are one person. By id where both have one, which survives a rename;
 * by handle where GitHub gave us nothing better.
 */
function samePerson(a: PokeMessageReviewer, b: PokeMessageReviewer): boolean {
  if (a.githubId && b.githubId) {
    return a.githubId === b.githubId;
  }

  return Boolean(a.login) && a.login === b.login;
}
