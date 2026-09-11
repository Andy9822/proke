import { GithubInboxPullRequest, GithubInbox } from './github-inbox-data.service';
import {
  InboxBuildFilters,
  InboxViewFilters,
  recentDraftWindowMs,
} from './core/entities/inbox-filters.interface';
import {
  InboxPullRequest,
  InboxSectionContent,
  InboxSectionKey,
  InboxStoredPullRequest,
  WAITING_SECTIONS,
  YOURS_SECTIONS,
} from './core/entities/inbox.interface';
import { ViewerTeamMembership } from './github-viewer-teams-data.service';

/**
 * Where every pull request goes, and in what order within a pile.
 *
 * Pure, and kept apart from both the fetch and the store, because these are the rules people
 * will argue about - "is an approved pull request with one stray open thread approved?" - and an
 * argument is easier to have against a function than against a GraphQL string.
 *
 * Two entry points, and the difference between them is the whole shape of the feature.
 * `classify` runs once with GitHub's answer in hand and produces what gets stored. Its half of
 * the rules reads facts about the pull request that the stored row does not keep - the review
 * decision, the timestamp - so it cannot be run again later.
 *
 * `groupWaitingOnYou` runs every time a stored snapshot is served. Its half reads facts about
 * the author, all of which the stored row does keep, so it can be run again as often as somebody
 * moves a switch - which is exactly why the settings it answers to cost neither a trip to GitHub
 * nor a place in the cache key. See inbox-filters.interface.ts.
 */

/**
 * The order matters and is not the display order.
 *
 * Drafts first because a draft is a draft whatever else is true of it. Then unresolved threads,
 * *above* approved: a pull request that has been signed off and still has an open question on it
 * is one where somebody is waiting on an answer, and "Approved" would tell the reader there is
 * nothing left to do. Everything else has simply not been looked at yet.
 *
 * The drafts split in two on nothing but recency. A draft you pushed to this morning is what you
 * are working on, and it is the one thing in this pile with any claim on your attention today;
 * the eleven you opened in March are a pile, and the point of a pile is that it stays shut. Same
 * rule, two headings, so the client can open one of them by default without opening the other.
 *
 * How far back "this morning" reaches is the reader's, and so is whether the split happens at
 * all: `recentDrafts: 'off'` returns null for the window, every draft goes to the one pile, and
 * the recent heading is left empty - which is how a section stops being drawn. Nothing about
 * that is a special case here; a window of nothing keeps nothing.
 */
function yoursSection(
  pullRequest: GithubInboxPullRequest,
  filters: InboxBuildFilters,
  now: number,
): InboxSectionKey {
  if (pullRequest.isDraft) {
    const windowMs = recentDraftWindowMs(filters.recentDrafts);

    return windowMs !== null && now - updatedMs(pullRequest) < windowMs
      ? InboxSectionKey.RecentDrafts
      : InboxSectionKey.Drafts;
  }

  if (pullRequest.hasUnresolvedThreads) {
    return InboxSectionKey.UnresolvedComments;
  }

  if (pullRequest.reviewDecision === 'APPROVED') {
    return InboxSectionKey.Approved;
  }

  return InboxSectionKey.WaitingForReviewers;
}

/**
 * Bots before teammates, deliberately: a machine that happens to be a member of a team is still
 * a machine, and the point of the bots pile is that nothing in it is a person waiting.
 *
 * Both headings are the reader's to switch off, and off means "in with everyone else" rather
 * than "gone". A heading is a claim that a group is worth looking at separately, and somebody
 * whose teams do not line up with who they actually review for is better served by one pile
 * than by a wrong one - but they still have to review the pull requests.
 *
 * "Everyone else" is where both fall back to, so it is never empty when the others are: it is
 * the pile that means "waiting on you", and the other two are refinements of it.
 */
function waitingSection(
  pullRequest: InboxStoredPullRequest,
  filters: InboxViewFilters,
): InboxSectionKey {
  if (pullRequest.authorIsBot) {
    return filters.separateBots ? InboxSectionKey.Bots : InboxSectionKey.Others;
  }

  // An empty `authorTeams` covers both "not on your team" and "we could not ask GitHub" - the
  // second being a missing permission as often as an outage. Neither is a reason to promote
  // somebody into the top pile, so both fall through to the middle one.
  if (filters.separateTeam && sharesTeam(pullRequest, filters.excludedTeams)) {
    return InboxSectionKey.Team;
  }

  return InboxSectionKey.Others;
}

/**
 * Whether any team this author is in still counts.
 *
 * `some` rather than "none of them are excluded": somebody in the company-wide team *and* in
 * your own team is your teammate on the strength of the second, whatever you did to the first.
 * The other reading would have striking out one broad team quietly remove people it was never
 * about.
 */
function sharesTeam(pullRequest: InboxStoredPullRequest, excludedTeams: string[]): boolean {
  return pullRequest.authorTeams.some((key) => !excludedTeams.includes(key));
}

/**
 * Most recently updated first, within every section.
 *
 * On GitHub's `updatedAt`, which is the field GitHub sorts its own lists by and the same one the
 * search behind this is asked to order on - so the page and the query agree about what "top of
 * the list" means, and the fifty rows the query returns are the fifty the page wants.
 *
 * This replaced oldest-created-first, which was standing in for how long you had been waiting.
 * It read well on the waiting-on-you half and badly everywhere else: a pull request somebody
 * pushed to ten minutes ago sat at the bottom of the pile under one they had abandoned in March,
 * and nothing on screen said why. Recency is the thing both halves have in common - what moved
 * last is what is live.
 */
function byRecency(a: GithubInboxPullRequest, b: GithubInboxPullRequest): number {
  const byUpdated = updatedMs(b) - updatedMs(a);

  // Ties are two rows written in the same second, so the newer pull request goes on top for the
  // same reason the newer update does.
  return byUpdated === 0 ? b.number - a.number : byUpdated;
}

/**
 * `updatedAt` as epoch milliseconds, and 0 where GitHub sent nothing that parses.
 *
 * Zero rather than NaN on purpose: a comparator that returns NaN gives a sort no ordering at all
 * and the result is engine-defined. This way an unreadable timestamp costs that one row its
 * place - it sorts to the bottom, and is never counted as a recent draft - and costs the rest
 * of the section nothing.
 */
function updatedMs(pullRequest: GithubInboxPullRequest): number {
  const parsed = Date.parse(pullRequest.updatedAt || '');

  return Number.isNaN(parsed) ? 0 : parsed;
}

function toPullRequest(pullRequest: GithubInboxPullRequest): InboxPullRequest {
  return {
    id: pullRequest.id,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    isDraft: pullRequest.isDraft,
    createdAt: pullRequest.createdAt,
    changedFiles: pullRequest.changedFiles,
    repositoryId: pullRequest.repositoryId,
    repositoryFullName: pullRequest.repositoryFullName,
    author: {
      login: pullRequest.authorLogin,
      avatarUrl: pullRequest.authorAvatarUrl,
    },
  };
}

/**
 * The same row, plus the two facts about its author that the view filters read later.
 *
 * This is where the cost of making those settings free is paid, and it is two fields on fifty
 * rows. Anything heavier than that belongs in a build filter instead.
 */
function toStoredPullRequest(
  pullRequest: GithubInboxPullRequest,
  teamsByMember: Map<string, string[]>,
): InboxStoredPullRequest {
  return {
    ...toPullRequest(pullRequest),
    authorIsBot: pullRequest.authorIsBot,
    authorTeams: teamsByMember.get(pullRequest.authorLogin.toLowerCase()) ?? [],
  };
}

/**
 * Login to the keys of the viewer's teams they are in.
 *
 * Built once per refresh rather than asked per row, because the alternative is a scan of every
 * team's membership for every pull request - fifty rows against twenty-five teams of a hundred
 * people each, to answer a question that is the same shape every time.
 */
function teamsByMember(teams: ViewerTeamMembership[] | null): Map<string, string[]> {
  const byMember = new Map<string, string[]>();

  for (const { team, members } of teams ?? []) {
    for (const member of members) {
      const existing = byMember.get(member);

      if (existing) {
        existing.push(team.key);
      } else {
        byMember.set(member, [team.key]);
      }
    }
  }

  return byMember;
}

/**
 * Every section is present, empty ones included.
 *
 * The client renders headings from this list, so a section that vanished when it emptied would
 * make the page reshuffle as work is finished - and "Approved: nothing" is a useful thing to be
 * told, where a missing heading is just a gap.
 */
function group(
  pullRequests: GithubInboxPullRequest[],
  keys: readonly InboxSectionKey[],
  sectionOf: (pullRequest: GithubInboxPullRequest) => InboxSectionKey,
): InboxSectionContent[] {
  const buckets = new Map<InboxSectionKey, GithubInboxPullRequest[]>(keys.map((key) => [key, []]));

  for (const pullRequest of pullRequests) {
    buckets.get(sectionOf(pullRequest))?.push(pullRequest);
  }

  return keys.map((key) => ({
    key,
    pullRequests: (buckets.get(key) ?? []).sort(byRecency).map(toPullRequest),
  }));
}

/**
 * Whether somebody else's pull request is still worth putting in front of you.
 *
 * Two rules, and they are different in kind. The first is not negotiable: a pull request you
 * opened and were then asked to review - GitHub allows it, and teams with review assignment on
 * do it - is already sitting under "Yours", and appearing twice would read as two pieces of
 * work.
 *
 * The second is the reader's to make. A pull request whose review decision is already APPROVED
 * has had the thing it was asking for, so by default it leaves the pile; anyone who wants to see
 * them anyway says so once in the settings. Only the *waiting on you* half is filtered - your
 * own approved pull requests are the ones with a button left to press, which is the opposite of
 * finished.
 *
 * Note what APPROVED does not mean: it is GitHub's decision for the pull request, not a record
 * of whether *you* reviewed it. A pull request approved by a colleague while your review is
 * still outstanding is exactly the case this filter is for.
 */
function isWaitingOnYou(
  pullRequest: GithubInboxPullRequest,
  viewerLogin: string,
  filters: InboxBuildFilters,
): boolean {
  if (pullRequest.authorLogin.toLowerCase() === viewerLogin.toLowerCase()) {
    return false;
  }

  return filters.includeApproved || pullRequest.reviewDecision !== 'APPROVED';
}

/**
 * What gets stored: the yours half in piles, the waiting half in order and not yet in piles.
 *
 * `now` is a parameter rather than a `Date.now()` inside, so that the one rule here that depends
 * on the clock - which drafts are recent - can be asserted against a fixed one.
 */
export function classify(
  inbox: GithubInbox,
  teams: ViewerTeamMembership[] | null,
  filters: InboxBuildFilters,
  now: number = Date.now(),
): { yours: InboxSectionContent[]; waitingOnYou: InboxStoredPullRequest[] } {
  const byMember = teamsByMember(teams);

  return {
    yours: group(inbox.yours, YOURS_SECTIONS, (pullRequest) =>
      yoursSection(pullRequest, filters, now),
    ),
    // Sorted here rather than at serve time, because the order does not depend on any setting -
    // and sorting once when the snapshot is written beats sorting on every read of it.
    waitingOnYou: inbox.waitingOnYou
      .filter((pullRequest) => isWaitingOnYou(pullRequest, inbox.viewerLogin, filters))
      .sort(byRecency)
      .map((pullRequest) => toStoredPullRequest(pullRequest, byMember)),
  };
}

/**
 * The stored waiting-on-you rows, in headings, as one reader has asked to see them.
 *
 * Runs on the way out rather than on the way in. Nothing here needs GitHub, so a reader who
 * strikes out a team or ignores an author sees the effect immediately, against the snapshot
 * already in hand - and every combination of these settings is served from the one stored
 * document instead of building a copy per combination.
 *
 * The ignored authors go first and go entirely, because that is what "ignore" means; the rest is
 * a question of which heading. Order within a heading is the order the rows arrive in, which
 * `classify` has already made recency.
 */
export function groupWaitingOnYou(
  pullRequests: InboxStoredPullRequest[],
  filters: InboxViewFilters,
): InboxSectionContent[] {
  const kept = pullRequests.filter(
    (pullRequest) => !filters.ignoredAuthors.includes(pullRequest.author.login.toLowerCase()),
  );

  const buckets = new Map<InboxSectionKey, InboxPullRequest[]>(
    WAITING_SECTIONS.map((key) => [key, []]),
  );

  for (const pullRequest of kept) {
    buckets.get(waitingSection(pullRequest, filters))?.push(toSentPullRequest(pullRequest));
  }

  return WAITING_SECTIONS.map((key) => ({ key, pullRequests: buckets.get(key) ?? [] }));
}

/**
 * A stored row stripped back to what a row renders.
 *
 * The two extra fields are how the grouping was decided, not something the page draws - and a
 * client that received "which of your teams this author is in" would be a client somebody would
 * eventually be tempted to group in.
 */
function toSentPullRequest({
  authorIsBot: _authorIsBot,
  authorTeams: _authorTeams,
  ...pullRequest
}: InboxStoredPullRequest): InboxPullRequest {
  return pullRequest;
}
