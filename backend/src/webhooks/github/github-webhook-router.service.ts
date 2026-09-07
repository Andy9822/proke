import { Injectable, Logger } from '@nestjs/common';
import { PokeDropReason } from '../../analytics/metrics-catalog';
import { MetricsService } from '../../analytics/metrics.service';
import { GithubCommentAuthorDataService } from '../../github-app/github-comment-author-data.service';
import { GithubPullRequestDataService } from '../../github-app/github-pull-request-data.service';
import {
  GithubTeamMember,
  GithubTeamMembersDataService,
} from '../../github-app/github-team-members-data.service';
import { GithubThreadParticipantsDataService } from '../../github-app/github-thread-participants-data.service';
import {
  GithubDiffStat,
  GithubNotificationNormalized,
  isReviewVerdict,
  PokeRequestedReviewers,
} from '../../notifications/core/entities/github-notification.interface';
import {
  comparePriority,
  NotificationType,
} from '../../notifications/core/entities/notification-type.enum';
import {
  PokeRemovedRequest,
  PokeResolutionEvent,
  PokeResolutionService,
  PokeReviewerEvent,
} from '../../notifications/delivery/poke-resolution.service';
import { ReviewBatchService } from '../../notifications/delivery/review-batch.service';
import { isPokeTypeMuted } from '../../notifications/core/poke-settings';
import { isNotificationAllowed } from '../../subscriptions/core/notification-preferences';
import { SubscriptionReadService } from '../../subscriptions/read/subscription-read.service';
import { UserNormalized } from '../../user/core/entities/user.interface';
import { UserReadService } from '../../user/read/user-read.service';
import { GithubRepositoryAccessDataService } from './github-repository-access-data.service';
import { extractMentions, MentionedTeam } from './github-mentions';

/**
 * Whoever should hear about this. By id where the payload gives one, by handle for mentions, and
 * by team where a group was named - which is a question for GitHub rather than a person yet.
 */
interface PokeRecipient {
  githubId?: string;
  githubLogin?: string;
  team?: MentionedTeam;
  /**
   * Whoever is in the thread this comment opened - a reply names it by id and nothing else, so
   * the people are a question for GitHub and for what we watched happen, rather than something
   * the payload already answered. Resolves to one poke each.
   */
  replyToCommentId?: string;
}

interface Poke {
  recipient: PokeRecipient;
  notification: GithubNotificationNormalized;
}

/** The bits of the payload every notification repeats. */
interface EventContext {
  repositoryFullName: string;
  actorLogin: string;
  /** The organisation's logo, or the owner's face on a repository belonging to a person. */
  ownerAvatarUrl?: string;
  /**
   * When the webhook arrived. Not part of the poke as anybody reads it - it rides here because
   * this object is already the one thing every notification built from an event has in common,
   * and threading a second argument through six resolvers would say less.
   */
  receivedAt: number;
}

/**
 * The thing being talked about, and what was said about it.
 *
 * One object rather than a growing list of positional arguments, because every resolver reads
 * the same handful of fields off whichever of `issue` or `pull_request` the event carries.
 */
interface PokeSubject {
  title?: string;
  htmlUrl?: string;
  /** The #number. How people actually refer to a pull request or an issue. */
  number?: number;
  body?: string;
  /** `approved`, `changes_requested`, `commented` - only ever set on a submitted review. */
  reviewState?: string;
  /** An issue has no diff, and a team mention can be either. */
  isPullRequest?: boolean;
  /** The review all of this belongs to, on the events that are part of one. */
  reviewId?: string;
  /** The inline comment this came from. Absent on the review submission itself. */
  commentId?: string;
  /**
   * The line counts, where the payload had them. Only `pull_request` events carry the full pull
   * request object; everything else has to be asked for, later and only if the poke survives.
   */
  diff?: GithubDiffStat;
}

/**
 * Turns a webhook payload into at most one poke per person.
 *
 * Routing is by GitHub user id out of the payload, or by handle for @mentions - never via the
 * installation. That only works because users are keyed on githubId; webhooks carry no email
 * at all.
 *
 * One event routinely produces several candidates for the same person: a comment on your own
 * pull request that also @s you is both. Candidates are collected first, filtered against that
 * person's preferences, and only then collapsed to the highest-priority survivor - collapsing
 * earlier would let a muted type swallow the poke a user actually asked for.
 */
@Injectable()
export class GithubWebhookRouterService {
  private readonly logger = new Logger(GithubWebhookRouterService.name);

  constructor(
    private readonly userReadService: UserReadService,
    private readonly subscriptionReadService: SubscriptionReadService,
    private readonly deliveryService: ReviewBatchService,
    private readonly teamMembersDataService: GithubTeamMembersDataService,
    private readonly repositoryAccessDataService: GithubRepositoryAccessDataService,
    private readonly pullRequestDataService: GithubPullRequestDataService,
    private readonly commentAuthorDataService: GithubCommentAuthorDataService,
    private readonly threadParticipantsDataService: GithubThreadParticipantsDataService,
    private readonly pokeResolutionService: PokeResolutionService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * One poke that a real person would have received, and did not.
   *
   * Every gate below drops candidates for a good reason and says nothing about it - a `continue`,
   * a debug line, or a filter that leaves no trace. Counted here they add up, and they add up
   * against `proke.poke.delivered`, which is the only way the funnel between "40,000 webhooks"
   * and "300 pokes" becomes a thing anybody can look at.
   *
   * Takes a count because several of these drop a group at once: a bot comment suppressed for
   * six people is one call rather than six.
   */
  private dropped(reason: PokeDropReason, count = 1): void {
    this.metrics.count('proke.poke.dropped', { reason }, count);
  }

  /**
   * Files away who wrote this comment and who it puts in the thread, so a reply to either later
   * need not ask GitHub.
   *
   * Only review comments: they are the only kind GitHub threads, and so the only kind anything
   * can be a reply *to*. Conversation comments are flat and carry no parent at all.
   */
  private rememberComment(event: string, payload: any): void {
    if (event !== 'pull_request_review_comment' || payload?.action !== 'created') {
      return;
    }

    const [owner, name, ...rest] = String(payload?.repository?.full_name ?? '').split('/');

    if (!owner || !name || rest.length > 0) {
      return;
    }

    const author = payload?.comment?.user;

    this.commentAuthorDataService.remember(
      owner,
      name,
      identifier(payload?.comment?.id),
      identifier(author?.id),
    );

    // Only a reply puts somebody in somebody else's thread. A comment that opens one is its
    // author's alone, and that is the author cache's answer rather than this one's.
    //
    // Bots are left out where they are only remembered here, unlike above: a bot in the set is a
    // recipient that costs a lookup on every later reply and is dropped at the end of it every
    // time. Their comments still open threads and still get answered - what a bot cannot be is
    // the reason somebody else gets poked.
    if (!isBot(author)) {
      this.threadParticipantsDataService.remember(
        owner,
        name,
        identifier(payload?.comment?.in_reply_to_id),
        identifier(author?.id),
      );
    }
  }

  /**
   * Turns "whoever is in the thread under comment 4" into people.
   *
   * Two answers, from two places, because GitHub only names one of them. Every reply points at
   * the comment that opened the thread, so its author is exact and comes back by id; everybody
   * else who has been talking in that thread is not in the payload at all and comes out of what
   * we watched happen. They are separated for the reader, not for the router - the person who
   * opened the thread is told somebody replied *to them*, and the rest are told the conversation
   * they are in moved on.
   *
   * A thread we can resolve nobody in pokes nobody - a deleted parent, a revoked token, a thread
   * from before this app was installed. The reply still reaches the pull request author and
   * anybody it named, because those candidates were resolved from the payload and never needed
   * this.
   */
  private async resolveReplyTargets(
    pokes: Poke[],
    installationId: string,
    repository: any,
    senderGithubId: string,
  ): Promise<Poke[]> {
    if (!pokes.some((poke) => poke.recipient.replyToCommentId)) {
      return pokes;
    }

    const [owner, name, ...rest] = String(repository?.full_name ?? '').split('/');
    const resolved: Poke[] = [];

    for (const poke of pokes) {
      const commentId = poke.recipient.replyToCommentId;

      if (!commentId) {
        resolved.push(poke);
        continue;
      }

      if (!owner || !name || rest.length > 0) {
        this.dropped('reply_unresolved');
        continue;
      }

      const starterGithubId = await this.commentAuthorDataService.readAuthor(
        installationId,
        owner,
        name,
        commentId,
      );

      // Whoever else has spoken in the thread, minus the two people who must not be in it: the
      // person who opened it, who is being poked more precisely a line below, and the person
      // writing this very reply, who was added to the set moments ago by `rememberComment`. The
      // sender would be dropped downstream either way - but as a candidate rather than as a
      // non-event, and every reply in a thread you are in would spend a lookup saying so.
      const others = new Set(this.threadParticipantsDataService.read(owner, name, commentId));

      others.delete(senderGithubId);

      if (starterGithubId) {
        others.delete(starterGithubId);

        resolved.push({
          recipient: { githubId: starterGithubId },
          notification: { ...poke.notification, threadStarter: true },
        });
      } else {
        // Counted even where the rest of the thread carries the poke on: whoever the reply was
        // aimed at is the one that was lost, and that is what this number is about.
        this.dropped('reply_unresolved');
        this.logger.debug(`Could not resolve the author of comment ${commentId}`);
      }

      for (const githubId of others) {
        resolved.push({ recipient: { githubId }, notification: poke.notification });
      }
    }

    return resolved;
  }

  /**
   * Edits review requests this event has moved on from: struck through where it settled them or
   * took them back, annotated where somebody merely reviewed without deciding.
   *
   * Above the early returns, like remembering a comment's author, and for a sharper version of
   * the same reason: the events that settle a review request usually poke nobody at all. The
   * reviewer is the sender, and the sender is never poked - so gating this on there being
   * candidates would miss precisely the case it exists for.
   *
   * This is also why it is not folded into `resolve`: that maps an event onto people it
   * concerns, and the people concerned here are the ones who are now off the hook - or who can
   * see somebody else is already on it.
   */
  private async editOutstandingPokes(event: string, payload: any): Promise<void> {
    const repositoryFullName = payload?.repository?.full_name;
    const number = payload?.pull_request?.number;

    if (!repositoryFullName || !Number.isFinite(number)) {
      return;
    }

    const settled = readResolution(event, payload);

    if (settled) {
      await this.pokeResolutionService.resolve(repositoryFullName, Number(number), settled);
      return;
    }

    const reviewer = readReviewer(event, payload);

    if (reviewer) {
      await this.pokeResolutionService.annotate(repositoryFullName, Number(number), reviewer);
    }
  }

  public async route(event: string, payload: any, receivedAt = Date.now()): Promise<void> {
    // Before everything, including the early returns. This event may poke nobody and still be
    // the only time we are told who wrote this comment - the reply that makes it matter can
    // arrive hours later, and asking GitHub then costs a call this line just saved.
    this.rememberComment(event, payload);
    await this.editOutstandingPokes(event, payload);

    const candidates = this.suppressBotChatter(
      this.resolve(event, payload, receivedAt),
      payload?.sender,
    );

    // Nothing is counted here. An event that concerned nobody has not dropped a poke, it never
    // had one - and folding those into the same counter would make its total mean nothing.
    if (candidates.length === 0) {
      return;
    }

    const installationId = payload?.installation?.id ? String(payload.installation.id) : undefined;

    // Every app-delivered event carries its installation. Without one we cannot tell which
    // opt-in would authorise the poke, so we do not send it.
    if (!installationId) {
      this.dropped('no_installation', candidates.length);
      this.logger.warn(`Dropping ${event} with no installation id`);
      return;
    }

    // After suppression so a bot naming a team costs no API call, and before grouping so a team
    // is just several more candidates by the time preferences are consulted.
    const expanded = await this.expandTeamRecipients(
      candidates,
      installationId,
      payload?.organization?.login,
    );

    const senderGithubId = String(payload?.sender?.id ?? '');

    // Same position and for the same reason: this decides *who* a reply is for, so unlike the
    // diff and the access check it cannot wait until after preferences. It is the one lookup in
    // this method that is not merely presentation, and the write-through above means it usually
    // resolves out of the cache without a call.
    const addressed = await this.resolveReplyTargets(
      expanded,
      installationId,
      payload?.repository,
      senderGithubId,
    );
    const pokes = withoutAuthorReviewRequests(addressed, payload?.pull_request);

    // Counted from the difference rather than inside the filter, which is a module-level
    // function with nothing injected and is better left that way.
    this.dropped('author_review_request', addressed.length - pokes.length);

    if (pokes.length === 0) {
      return;
    }

    const repositoryId =
      payload?.repository?.id === undefined || payload?.repository?.id === null
        ? undefined
        : String(payload.repository.id);

    for (const { user, notifications } of (await this.groupByUser(pokes)).values()) {
      // Nobody wants to be told about their own action - including mentioning themselves.
      if (user.githubId && user.githubId === senderGithubId) {
        this.dropped('self');
        continue;
      }

      // Installation is somebody else's decision, usually a colleague's. Being poked is
      // this user's, so an install alone is never enough.
      const preferences = await this.subscriptionReadService.readPreferences(
        user.id,
        installationId,
      );

      if (!preferences) {
        this.dropped('not_subscribed');
        continue;
      }

      // Two gates, and both have to pass. The account-wide one is a fact about the person and
      // came in with them, so it costs nothing; the subscription's is about this one
      // organisation. They compose by intersection, which is the whole rule: an organisation can
      // narrow what somebody receives and can never widen it past what their own settings say.
      const wanted = notifications
        .filter(
          (notification) =>
            !isPokeTypeMuted(user.pokeSettings, notification.type) &&
            isNotificationAllowed(preferences, repositoryId, notification.type),
        )
        .sort((a, b) => comparePriority(a.type, b.type));

      // One per person rather than per candidate, here and above: what is lost is the single
      // poke this person would have got, whichever of their candidates would have won it.
      //
      // Which of the two gates to blame is worth the second pass. "Switched this kind off
      // everywhere" and "listens to this org but not to this" look identical in a total and are
      // completely different things to learn about a settings panel nobody had until now.
      if (wanted.length === 0) {
        this.dropped(
          notifications.every((notification) =>
            isPokeTypeMuted(user.pokeSettings, notification.type),
          )
            ? 'type_muted'
            : 'muted',
        );
        continue;
      }

      // Last, and after preferences on purpose: this is the only gate that costs a GitHub call,
      // so it is not worth paying for somebody who muted this kind of poke anyway.
      if (!(await this.maySeeRepository(user, payload?.repository))) {
        continue;
      }

      await this.deliveryService.submit(user, await this.withDiff(wanted[0], installationId));
    }
  }

  /**
   * Fills in the line counts the payload did not carry.
   *
   * Last of all, and past every gate above, because it is the second thing here that costs a
   * GitHub call and the only one spent on presentation rather than on whether to poke at all -
   * a poke nobody is getting must not pay for it. The call is cached per pull request, so a
   * thread being commented on costs one for everybody it reaches.
   */
  private async withDiff(
    notification: GithubNotificationNormalized,
    installationId: string,
  ): Promise<GithubNotificationNormalized> {
    if (notification.diff || !notification.isPullRequest || !notification.number) {
      return notification;
    }

    const [owner, name, ...rest] = notification.repositoryFullName.split('/');

    if (!owner || !name || rest.length > 0) {
      return notification;
    }

    const diff = await this.pullRequestDataService.readDiff(
      installationId,
      owner,
      name,
      notification.number,
    );

    // A poke without the size is still the poke. Nothing here is worth dropping one over.
    return diff ? { ...notification, diff } : notification;
  }

  /**
   * Whether this person is allowed to know the event happened at all.
   *
   * Everything above this line reasons about the *installation*: which one the event came from,
   * and whether this user opted into it. None of that is repository access. An org-wide install
   * covers repositories a given member cannot open, and an @mention is only prose - anybody can
   * type anybody's handle into an issue in a private repository, and a team mention reaches
   * every member of a team whether or not that team can see where it was written.
   *
   * Without this the poke relays the repository name, the title and a quote of the comment to
   * somebody GitHub itself would not have notified.
   *
   * Public repositories skip the call: there is nothing to leak, and it is the common case.
   */
  private async maySeeRepository(user: UserNormalized, repository: any): Promise<boolean> {
    if (repository?.private === false) {
      return true;
    }

    const repositoryFullName = repository?.full_name;

    // Nothing to ask about. Every event we route carries a repository, so this is a malformed
    // payload rather than a kind of event, and a poke naming no repository is no loss.
    if (!repositoryFullName) {
      this.dropped('access_unknown');
      this.logger.warn('Dropping a poke for an event carrying no repository');
      return false;
    }

    const access = await this.repositoryAccessDataService.canAccess(user, repositoryFullName);

    if (access === null) {
      // A revoked token, a rate limit, GitHub being down. Failing open here is the whole leak
      // this check exists to close, so a question we could not ask is a no.
      //
      // Counted apart from a plain refusal, and it is the one number in this metric worth an
      // alert of its own: a refusal is the check working, while this is a poke lost to an
      // unrelated failure that leaves no other trace anywhere.
      this.dropped('access_unknown');
      this.logger.warn(
        `Dropping a poke for ${user.githubLogin ?? user.id}: could not confirm access to ` +
          repositoryFullName,
      );
      return false;
    }

    if (!access) {
      this.dropped('no_repo_access');
    }

    return access;
  }

  /**
   * Drops the kinds of poke a bot has no business sending.
   *
   * CI bots, coverage bots and dependency bots comment constantly, and a machine writing your
   * @handle is not a colleague asking you something - it is the single largest source of noise
   * in a GitHub notification inbox, and the reason people stop reading them.
   *
   * Deliberately narrow. A bot can still reach you when the event is about *your* work rather
   * than its own chatter: a merge queue landing your pull request, or an automation asking you
   * to review one, are real and still arrive. Only the talking is suppressed.
   *
   * Applied before preferences and before collapsing, so a bot comment that also mentions you
   * cannot survive as the lower-priority half of the pair.
   */
  private suppressBotChatter(pokes: Poke[], sender: any): Poke[] {
    if (!isBot(sender)) {
      return pokes;
    }

    const kept = pokes.filter((poke) => !BOT_SUPPRESSED_TYPES.includes(poke.notification.type));

    if (kept.length < pokes.length) {
      this.dropped('bot_chatter', pokes.length - kept.length);
      this.logger.debug(
        `Suppressed ${pokes.length - kept.length} poke(s) from bot ${sender?.login}`,
      );
    }

    return kept;
  }

  /**
   * Turns a team into the people in it - one candidate each, all carrying the notification built
   * from whatever named the team, whether that was an `@org/team` in a sentence or GitHub asking
   * the group for a review. A team we cannot resolve pokes nobody, deliberately: the alternative
   * is guessing at who was meant.
   */
  private async expandTeamRecipients(
    pokes: Poke[],
    installationId: string,
    organizationLogin: string | undefined,
  ): Promise<Poke[]> {
    if (!pokes.some((poke) => poke.recipient.team)) {
      return pokes;
    }

    const expanded: Poke[] = [];

    for (const poke of pokes) {
      const team = poke.recipient.team;

      if (!team) {
        expanded.push(poke);
        continue;
      }

      const members = await this.readTeamMembers(team, installationId, organizationLogin);

      // No such team, not visible, too big, or a token that would not answer. One count rather
      // than one per member, because how many people it would have reached is exactly what we
      // failed to find out.
      if (members.length === 0) {
        this.dropped('team_unresolved');
      }

      for (const member of members) {
        expanded.push({
          recipient: { githubId: member.githubId },
          notification: poke.notification,
        });
      }
    }

    return expanded;
  }

  private async readTeamMembers(
    team: MentionedTeam,
    installationId: string,
    organizationLogin: string | undefined,
  ): Promise<GithubTeamMember[]> {
    // The event's own org is the only one we hold a token for. `@someone-else/team` is prose,
    // and a repository owned by a person has no teams at all.
    if (!organizationLogin || team.org.toLowerCase() !== organizationLogin.toLowerCase()) {
      return [];
    }

    try {
      return (
        (await this.teamMembersDataService.listMembers(installationId, team.org, team.slug)) ?? []
      );
    } catch (error) {
      // One unreachable team must not cost the other people this event was going to poke.
      this.logger.warn(`Could not expand @${team.handle}: ${error}`);
      return [];
    }
  }

  /**
   * Resolves every candidate to a real user and buckets by user id, so that someone reachable
   * both by id and by handle in the same event still ends up as one bucket.
   */
  private async groupByUser(
    pokes: Poke[],
  ): Promise<Map<string, { user: UserNormalized; notifications: GithubNotificationNormalized[] }>> {
    const resolved = new Map<string, UserNormalized | null>();
    const grouped = new Map<
      string,
      { user: UserNormalized; notifications: GithubNotificationNormalized[] }
    >();

    for (const poke of pokes) {
      const key = poke.recipient.githubId
        ? `id:${poke.recipient.githubId}`
        : `login:${poke.recipient.githubLogin?.toLowerCase()}`;

      if (!resolved.has(key)) {
        const found = await this.readRecipient(poke.recipient);
        resolved.set(key, found);

        // Counted on the lookup rather than per candidate, so somebody reached twice by one
        // event - named in the body of their own pull request, say - is one poke that could not
        // be delivered rather than two. Easily the largest bar on the chart, and worth having as
        // the scale the rest is read against rather than as unmeasured background.
        if (!found) {
          this.dropped('not_a_user');
        }
      }

      const user = resolved.get(key);

      // Not a PRoke user. Expected - we get events for whole orgs, most of whose members
      // have never signed up.
      if (!user) {
        continue;
      }

      const bucket = grouped.get(user.id);

      if (bucket) {
        bucket.notifications.push(poke.notification);
      } else {
        grouped.set(user.id, { user, notifications: [poke.notification] });
      }
    }

    return grouped;
  }

  /**
   * By id whenever the payload carries one, and only then by handle.
   *
   * The order is the point. A GitHub id is permanent and never reused; a handle is released the
   * instant its owner renames, and somebody else can hold it minutes later. Every event that
   * names a person structurally - a review request, a merge, the author of a pull request -
   * carries the id, so the handle path is reached only for @mentions, which are parsed out of
   * prose and have nothing else to go on. UserWriteService keeps that path honest by releasing
   * a handle from any stale row the moment its new owner signs in.
   */
  private async readRecipient(recipient: PokeRecipient): Promise<UserNormalized | null> {
    if (recipient.githubId) {
      return this.userReadService.readByGithubId(recipient.githubId);
    }

    if (recipient.githubLogin) {
      return this.userReadService.readByGithubLogin(recipient.githubLogin);
    }

    return null;
  }

  private resolve(event: string, payload: any, receivedAt: number): Poke[] {
    const context: EventContext = {
      repositoryFullName: payload?.repository?.full_name ?? '',
      actorLogin: payload?.sender?.login ?? '',
      ownerAvatarUrl: payload?.repository?.owner?.avatar_url,
      receivedAt,
    };

    switch (event) {
      case 'pull_request':
        return this.resolvePullRequest(payload, context);
      case 'pull_request_review':
        return this.resolvePullRequestReview(payload, context);
      case 'pull_request_review_comment':
        return this.resolvePullRequestReviewComment(payload, context);
      case 'issue_comment':
        return this.resolveIssueComment(payload, context);
      case 'issues':
        return this.resolveIssues(payload, context);
      default:
        return [];
    }
  }

  private resolvePullRequest(payload: any, context: EventContext): Poke[] {
    const pullRequest = payload?.pull_request;

    if (!pullRequest) {
      return [];
    }

    const subject: PokeSubject = {
      title: pullRequest.title,
      htmlUrl: pullRequest.html_url,
      number: pullRequest.number,
      isPullRequest: true,
      // The one event that carries the full pull request object, so the one where the size of
      // the change is free.
      diff: readDiff(pullRequest),
    };

    if (payload.action === 'review_requested' && payload.requested_reviewer) {
      return [
        {
          recipient: { githubId: String(payload.requested_reviewer.id) },
          notification: this.build(
            NotificationType.ReviewRequested,
            subject,
            requester(payload, context),
          ),
        },
      ];
    }

    // The same action told the other way round: GitHub names a person in `requested_reviewer`
    // and a group in `requested_team`, never both, so a team asked for review arrives with the
    // reviewer half of the payload simply absent.
    //
    // It stays a review request rather than becoming a team mention, because that is what it is
    // to everyone in the team - something waiting on them, not somebody talking. The handle
    // rides along so the poke can say which team was asked rather than implying it was personal.
    //
    // A team with review assignment on is followed, a second later, by GitHub asking some of its
    // members by name through the branch above. The batch downstream folds the two into one
    // poke for anybody who was reached both ways.
    if (payload.action === 'review_requested' && payload.requested_team?.slug) {
      // Teams belong to organisations and only this half of the payload names one. A repository
      // owned by a person has no teams, so it cannot produce this event in the first place.
      const org = payload.organization?.login;

      if (!org) {
        return [];
      }

      const team: MentionedTeam = {
        org,
        slug: payload.requested_team.slug,
        handle: `${org}/${payload.requested_team.slug}`,
      };

      return [
        {
          recipient: { team },
          notification: this.build(
            NotificationType.ReviewRequested,
            subject,
            requester(payload, context),
            team.handle,
          ),
        },
      ];
    }

    // `closed` fires for abandoned pull requests too; only a merge is worth a poke.
    if (payload.action === 'closed' && pullRequest.merged && pullRequest.user) {
      return [
        {
          recipient: { githubId: String(pullRequest.user.id) },
          notification: this.build(NotificationType.PullRequestMerged, subject, context),
        },
      ];
    }

    // Armed, not landed: GitHub does the merge itself once the last check goes green, so the
    // author's window to object opens here and the merge poke is the news that it has shut.
    // Both arriving for one pull request is intended - they are two different facts about it.
    //
    // Bots are deliberately left unsuppressed. Mergify and its kind arming somebody's branch is
    // precisely the sort of thing its author wants to hear about, however routine it is.
    if (payload.action === 'auto_merge_enabled' && pullRequest.user) {
      return [
        {
          recipient: { githubId: String(pullRequest.user.id) },
          notification: this.build(NotificationType.AutoMergeEnabled, subject, context),
        },
      ];
    }

    // Only on open. `edited` fires on every description tweak and would re-poke everyone
    // already named in it.
    if (payload.action === 'opened') {
      return this.mentionPokes(
        NotificationType.PullRequestMention,
        { ...subject, body: pullRequest.body },
        context,
      );
    }

    return [];
  }

  private resolvePullRequestReview(payload: any, context: EventContext): Poke[] {
    const pullRequest = payload?.pull_request;

    if (payload?.action !== 'submitted' || !pullRequest) {
      return [];
    }

    const subject: PokeSubject = {
      title: pullRequest.title,
      htmlUrl: payload.review?.html_url ?? pullRequest.html_url,
      number: pullRequest.number,
      isPullRequest: true,
      // Empty on a bare approval, which is right: there is nothing to quote.
      body: payload.review?.body,
      // Approving and demanding changes are opposite news and read as such; the type alone
      // cannot say which happened.
      reviewState: payload.review?.state,
      // The other half of the review - one webhook per inline comment - carries this same id,
      // which is the whole basis for the two arriving as one poke.
      reviewId: identifier(payload.review?.id),
    };

    const pokes: Poke[] = [];

    if (pullRequest.user) {
      pokes.push({
        recipient: { githubId: String(pullRequest.user.id) },
        notification: this.build(NotificationType.ReviewSubmitted, subject, context),
      });
    }

    pokes.push(...this.mentionPokes(NotificationType.PullRequestMention, subject, context));

    return pokes;
  }

  private resolvePullRequestReviewComment(payload: any, context: EventContext): Poke[] {
    const pullRequest = payload?.pull_request;

    if (payload?.action !== 'created' || !pullRequest) {
      return [];
    }

    const subject: PokeSubject = {
      title: pullRequest.title,
      htmlUrl: payload.comment?.html_url ?? pullRequest.html_url,
      number: pullRequest.number,
      isPullRequest: true,
      body: payload.comment?.body,
      // GitHub attaches every inline comment to a review, including the one it opens behind the
      // scenes for a single comment left outside of one.
      reviewId: identifier(payload.comment?.pull_request_review_id),
      commentId: identifier(payload.comment?.id),
    };

    const pokes: Poke[] = [];

    if (pullRequest.user) {
      pokes.push({
        recipient: { githubId: String(pullRequest.user.id) },
        notification: this.build(NotificationType.PullRequestComment, subject, context),
      });
    }

    // Present only on a reply, and always the comment that opened the thread rather than the one
    // directly above - GitHub offers no pointer to that, so "replied to you" means "replied in
    // your thread". Collapsing takes care of the author replying in their own pull request's
    // thread: that is one person with two candidates, and this one outranks the comment.
    const replyTo = identifier(payload.comment?.in_reply_to_id);

    if (replyTo) {
      pokes.push({
        recipient: { replyToCommentId: replyTo },
        notification: this.build(NotificationType.CommentReply, subject, context),
      });
    }

    pokes.push(...this.mentionPokes(NotificationType.PullRequestMention, subject, context));

    return pokes;
  }

  private resolveIssueComment(payload: any, context: EventContext): Poke[] {
    const issue = payload?.issue;

    if (payload?.action !== 'created' || !issue) {
      return [];
    }

    // GitHub sends conversation comments on pull requests as `issue_comment`; the only thing
    // separating the two is this field.
    const isPullRequest = Boolean(issue.pull_request);
    const subject: PokeSubject = {
      title: issue.title,
      htmlUrl: payload.comment?.html_url ?? issue.html_url,
      number: issue.number,
      isPullRequest,
      body: payload.comment?.body,
    };

    const pokes: Poke[] = [];

    // Whoever opened the thing being commented on, whichever kind of thing it is. Two types
    // rather than one because they are two preferences: somebody following their pull requests
    // closely may well not want every reply on an issue they filed a year ago.
    if (issue.user) {
      pokes.push({
        recipient: { githubId: String(issue.user.id) },
        notification: this.build(
          isPullRequest ? NotificationType.PullRequestComment : NotificationType.IssueComment,
          subject,
          context,
        ),
      });
    }

    pokes.push(
      ...this.mentionPokes(
        isPullRequest ? NotificationType.PullRequestMention : NotificationType.IssueMention,
        subject,
        context,
      ),
    );

    return pokes;
  }

  private resolveIssues(payload: any, context: EventContext): Poke[] {
    const issue = payload?.issue;

    if (payload?.action !== 'opened' || !issue) {
      return [];
    }

    return this.mentionPokes(
      NotificationType.IssueMention,
      {
        title: issue.title,
        htmlUrl: issue.html_url,
        number: issue.number,
        body: issue.body,
      },
      context,
    );
  }

  /**
   * Everybody named in a body, whether by handle or through a team they are in.
   *
   * Both are `type` - the mention type for wherever this was written. Being named through a
   * group is not a different kind of poke from being named outright, it is the same poke that
   * happens to have arrived via a team, and the handle rides along so the message can say so
   * rather than claiming somebody wrote your name. The same reasoning as a review requested of a
   * team, which has always been a review request; see resolvePullRequest.
   */
  private mentionPokes(
    type: NotificationType,
    subject: PokeSubject,
    context: EventContext,
  ): Poke[] {
    // The text that mentions somebody is the whole reason they are being poked, so it travels
    // with the poke rather than being thrown away after the @handles are pulled out of it.
    const { logins, teams } = extractMentions(subject.body);

    return [
      ...logins.map((githubLogin) => ({
        recipient: { githubLogin },
        notification: this.build(type, subject, context),
      })),
      ...teams.map((team) => ({
        recipient: { team },
        notification: this.build(type, subject, context, team.handle),
      })),
    ];
  }

  private build(
    type: NotificationType,
    subject: PokeSubject,
    context: EventContext,
    teamHandle?: string,
  ): GithubNotificationNormalized {
    return {
      type,
      title: subject.title ?? '',
      htmlUrl: subject.htmlUrl ?? '',
      number: subject.number,
      repositoryFullName: context.repositoryFullName,
      actorLogin: context.actorLogin,
      excerpt: normalizeBody(subject.body),
      reviewState: subject.reviewState?.toLowerCase(),
      teamHandle,
      ownerAvatarUrl: context.ownerAvatarUrl,
      isPullRequest: subject.isPullRequest,
      diff: subject.diff,
      reviewId: subject.reviewId,
      commentId: subject.commentId,
      receivedAt: context.receivedAt,
    };
  }
}

/**
 * Whose name goes on a review request.
 *
 * In a busy repository most requests are made by a bot - a CODEOWNERS resolver, an assignment
 * action - on the author's behalf, seconds after the pull request opens. "pr-assigner[bot]
 * requested your review" is true and useless: what the reader wants from the line is whose
 * work is waiting on them, and that is the author. So a bot's ask is put in the author's name,
 * and a person's left in theirs - somebody asking you to look at a colleague's pull request is
 * news in itself.
 *
 * The sender itself is untouched: the rule that nobody is poked about their own action still
 * goes by who actually did it.
 */
function requester(payload: any, context: EventContext): EventContext {
  const author = payload?.pull_request?.user?.login;

  if (!isBot(payload?.sender) || !author) {
    return context;
  }

  return { ...context, actorLogin: author };
}

/**
 * Nobody reviews their own pull request, so nobody is asked to.
 *
 * GitHub enforces this for a person - the author cannot be requested by name - but not for a
 * team: ask the author's own team and the author is in it, which is the ordinary case wherever
 * a team owns the code it changes. Nor does the sender rule catch it, because the asking is
 * usually done by a bot on the author's behalf the moment the pull request opens.
 *
 * After team expansion, which is the only place this can arise, and by id, which is what the
 * expansion hands back.
 */
function withoutAuthorReviewRequests(pokes: Poke[], pullRequest: any): Poke[] {
  const authorGithubId = identifier(pullRequest?.user?.id);

  if (!authorGithubId) {
    return pokes;
  }

  return pokes.filter(
    (poke) =>
      poke.notification.type !== NotificationType.ReviewRequested ||
      poke.recipient.githubId !== authorGithubId,
  );
}

/**
 * A GitHub id as a string, or nothing at all.
 *
 * `String(undefined)` is `"undefined"`, which would batch every review that arrived without an
 * id into one - so the check has to happen before the conversion rather than after it.
 */
function identifier(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * What, if anything, this event did to make an outstanding review request untrue.
 *
 * Any verdict counts, and from anybody - not only from the person a given request was addressed
 * to. A pull request somebody has already looked at is one the rest of the queue can stop
 * worrying about, and being told four times over that four people were asked is the pestering
 * this whole product exists to stop. The edit names who did it, so nobody has to guess whether
 * it was them.
 *
 * A review that reached no verdict settles nothing. GitHub leaves the request pending when
 * somebody comments without deciding, and a message that says otherwise would be ahead of the
 * pull request it describes.
 */
function readResolution(event: string, payload: any): PokeResolutionEvent | undefined {
  const state = payload?.review?.state;

  if (
    event === 'pull_request_review' &&
    payload?.action === 'submitted' &&
    isReviewVerdict(state)
  ) {
    return {
      kind: state,
      // The review's own author rather than the sender. They are the same person on every
      // payload GitHub sends today, and only one of them is what the field means.
      actorGithubId: identifier(payload.review?.user?.id),
      actorLogin: payload.review?.user?.login,
      requested: readRequested(payload),
    };
  }

  // Merged or abandoned, the request is moot either way - unlike the poke to the author, which
  // only a merge is worth sending.
  if (event === 'pull_request' && payload?.action === 'closed') {
    return {
      kind: payload.pull_request?.merged ? 'merged' : 'closed',
      actorGithubId: identifier(payload.sender?.id),
      actorLogin: payload.sender?.login,
    };
  }

  // The ask taken back by hand. Nobody is poked about it - what it says is that there is nothing
  // to do - but a message saying there was is now wrong, and only the person it was addressed
  // to is concerned. Which person, or which team, rides along so the resolution edits that
  // message and no other on the pull request.
  if (event === 'pull_request' && payload?.action === 'review_request_removed') {
    const removed = readRemovedRequest(payload);

    if (!removed) {
      return undefined;
    }

    return {
      kind: 'removed',
      actorGithubId: identifier(payload.sender?.id),
      actorLogin: payload.sender?.login,
      requested: readRequested(payload),
      removed,
    };
  }

  return undefined;
}

/**
 * Who GitHub still lists as asked, off the pull request the event carries.
 *
 * Both lists are on every pull request object GitHub sends, cut down or not, in the state the
 * pull request is in once the event has happened - so on a review, the reviewer is already off
 * it. Absent only where the payload does not have them, which reads downstream as nobody still
 * asked: the behaviour every reader had before the lists were consulted at all.
 */
function readRequested(payload: any): PokeRequestedReviewers | undefined {
  const reviewers = payload?.pull_request?.requested_reviewers;
  const teams = payload?.pull_request?.requested_teams;

  if (!Array.isArray(reviewers) || !Array.isArray(teams)) {
    return undefined;
  }

  const org = organizationLogin(payload);

  return {
    githubIds: reviewers
      .map((reviewer) => identifier(reviewer?.id))
      .filter((id): id is string => id !== undefined),
    teamHandles: org
      ? teams.filter((team) => team?.slug).map((team) => teamHandle(org, team.slug))
      : [],
  };
}

/**
 * Whose request a removal took away - a person, or a team, the same way a request names one or
 * the other and never both. Nothing where the payload names neither, which is not a removal we
 * can act on.
 */
function readRemovedRequest(payload: any): PokeRemovedRequest | undefined {
  const githubId = identifier(payload?.requested_reviewer?.id);

  if (githubId) {
    return { githubId };
  }

  const org = organizationLogin(payload);
  const slug = payload?.requested_team?.slug;

  return org && slug ? { teamHandle: teamHandle(org, slug) } : undefined;
}

/**
 * The organisation whose teams these are. Named outright on every organisation event, and where
 * it is not, the repository's owner is the same organisation: a team can only be asked to review
 * a repository its own organisation owns, and a repository owned by a person has no teams.
 */
function organizationLogin(payload: any): string | undefined {
  return payload?.organization?.login ?? payload?.repository?.owner?.login;
}

/** `org/slug`, lowercased - GitHub treats both halves case-insensitively, and so must we. */
function teamHandle(org: string, slug: string): string {
  return `${org}/${slug}`.toLowerCase();
}

/**
 * Who, if anybody, this event says has reviewed the pull request without deciding about it.
 *
 * A submitted review with no verdict, and nothing else. A comment in the conversation is
 * somebody talking, not somebody reviewing, and "Reviewed by" would claim more than happened;
 * the inline comments, by contrast, already arrive inside one of these, because GitHub opens a
 * commented review around every one.
 *
 * Which is also why the author is left out: replying in a thread on your own pull request opens
 * one of these too, and the author answering their reviewers is not a review. Bots are left out
 * because the line exists to say a person is already on this, and a linter is not a person -
 * unlike a verdict, where what a bot does to a pull request counts as much as anybody's.
 */
function readReviewer(event: string, payload: any): PokeReviewerEvent | undefined {
  if (event !== 'pull_request_review' || payload?.action !== 'submitted') {
    return undefined;
  }

  // The state is checked by name rather than as "not a verdict": GitHub has more states than
  // the three a submission carries, and a review that is none of them should annotate nothing.
  const reviewer = payload.review?.user;

  if (payload.review?.state !== 'commented' || !reviewer || isBot(reviewer)) {
    return undefined;
  }

  const reviewerId = identifier(reviewer.id);

  if (reviewerId !== undefined && reviewerId === identifier(payload.pull_request?.user?.id)) {
    return undefined;
  }

  return { actorGithubId: reviewerId, actorLogin: reviewer.login };
}

/**
 * The line counts off a full pull request object, and nothing off a cut-down one.
 *
 * Absent rather than zero where the payload does not say, so that "we were not told" stays
 * distinguishable from "nothing changed" all the way to the message - the two look identical
 * once they are rendered, and only one of them is true.
 */
function readDiff(pullRequest: any): GithubDiffStat | undefined {
  if (!Number.isFinite(pullRequest?.additions) || !Number.isFinite(pullRequest?.deletions)) {
    return undefined;
  }

  return { additions: pullRequest.additions, deletions: pullRequest.deletions };
}

/**
 * The talking. What a bot says is noise; what a bot *does* to your pull request is not, so
 * review requests, submitted reviews and merges are missing from this list on purpose.
 */
const BOT_SUPPRESSED_TYPES: NotificationType[] = [
  NotificationType.PullRequestComment,
  // A bot on an issue is if anything worse than one on a pull request: stale-bots, triage
  // labellers and template-checkers talk to issues that nobody has touched in months.
  NotificationType.IssueComment,
  // A bot answering in your thread is the same talking, and suppressed here rather than later
  // so it never costs the lookup its recipient would have needed.
  NotificationType.CommentReply,
  // Covers a bot naming a team as well - the same noise multiplied by everyone in it, and one
  // of these two types since a team mention stopped being a type of its own.
  NotificationType.PullRequestMention,
  NotificationType.IssueMention,
];

/**
 * Whether an actor is a machine.
 *
 * `type` is what GitHub actually promises, and the suffix is the belt to its braces - the two
 * disagree in a few payloads, and a missed bot is a notification somebody did not want. Matched
 * as a suffix rather than a substring so that a person called `robotnik` stays a person.
 */
function isBot(sender: any): boolean {
  return sender?.type === 'Bot' || /\[bot\]$/i.test(sender?.login ?? '');
}

/**
 * What somebody wrote, minus what they did not.
 *
 * Pull request and issue templates are mostly HTML comments, and a description that is nothing
 * but an unfilled template should read as no message at all rather than as a wall of
 * instructions the author never saw.
 */
function normalizeBody(body: string | undefined): string | undefined {
  if (!body) {
    return undefined;
  }

  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    // Blank-line runs are load-bearing in markdown but not worth relaying.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}
