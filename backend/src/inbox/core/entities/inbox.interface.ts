import { InboxBuildFilters } from './inbox-filters.interface';

/**
 * Which pile a pull request landed in, and in what order the piles are read.
 *
 * The server decides this rather than the client, because every rule behind it needs something
 * the browser does not have: whether a review thread is still open, whether the author is a
 * teammate, whether the author is a machine. The client owns the words on the heading and
 * nothing else.
 */
export enum InboxSectionKey {
  /** Yours: signed off, nothing left to do but press the button. */
  Approved = 'approved',
  /** Yours: at least one review thread is still open. Someone is waiting on you. */
  UnresolvedComments = 'unresolved-comments',
  /** Yours: nobody has said anything yet. */
  WaitingForReviewers = 'waiting-for-reviewers',
  /** Yours: a draft you have touched in the last day. Work in progress, rather than a pile. */
  RecentDrafts = 'recent-drafts',
  /** Yours: a note to yourself. Asking nothing of anyone. */
  Drafts = 'drafts',
  /** Waiting on you: written by someone you share a GitHub team with. */
  Team = 'team',
  /** Waiting on you: written by a person you do not. */
  Others = 'others',
  /** Waiting on you: written by a machine. */
  Bots = 'bots',
}

export const YOURS_SECTIONS = [
  InboxSectionKey.Approved,
  InboxSectionKey.UnresolvedComments,
  InboxSectionKey.WaitingForReviewers,
  InboxSectionKey.RecentDrafts,
  InboxSectionKey.Drafts,
] as const;

export const WAITING_SECTIONS = [
  InboxSectionKey.Team,
  InboxSectionKey.Others,
  InboxSectionKey.Bots,
] as const;

export interface InboxAuthor {
  login: string;
  avatarUrl?: string;
}

/**
 * One pull request, carrying exactly what a row renders.
 *
 * Deliberately narrower than what GitHub was asked for. The query behind this also pulls the
 * review decision, the check rollup and the thread states, because the classifier needs them -
 * so surfacing any of those later is a field on this interface rather than another API call.
 */
export interface InboxPullRequest {
  /** GitHub's node id. Survives a rename of the repository or of the author. */
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** ISO 8601, as GitHub gave it. When the pull request was opened, not when it last moved. */
  createdAt: string;
  changedFiles: number;
  repositoryId: string;
  repositoryFullName: string;
  author: InboxAuthor;
}

export interface InboxSectionContent {
  key: InboxSectionKey;
  /** Server-ordered. The client renders them in the order it is given. */
  pullRequests: InboxPullRequest[];
}

/**
 * One of the viewer's GitHub teams.
 *
 * Carried out to the client so the settings can show somebody the teams their own grouping is
 * built from and let them strike one out. Without the list, "your team" is a heading whose rule
 * is invisible - and the person it groups wrongly is exactly the person who cannot see why.
 */
export interface ViewerTeam {
  /** `org/slug`, lowercased. What `excludedTeams` names, and the render key. */
  key: string;
  org: string;
  slug: string;
  /** GitHub's display name for the team, which is not its slug. For the words on the row. */
  name: string;
}

/**
 * A waiting-on-you row as it is stored, which is a little more than a row as it is sent.
 *
 * The two extra fields are the whole reason the view filters can be view filters. Which pile
 * this lands in is decided when the snapshot is served, so the facts that decision needs have
 * to survive in the stored document - GitHub is not going to be asked again to answer a
 * question about a checkbox.
 *
 * They are small on purpose. Anything expensive to keep per row belongs in a build filter
 * instead, where it is applied once and thrown away.
 */
export interface InboxStoredPullRequest extends InboxPullRequest {
  /** GitHub calls a GitHub App's account a Bot. Decided at fetch time, kept for `separateBots`. */
  authorIsBot: boolean;
  /**
   * The keys of the viewer's teams this author is in - usually none, occasionally several.
   *
   * A list rather than a boolean because `excludedTeams` asks which ones. Somebody who strikes
   * out the company-wide team still shares their own team with half these authors, and a stored
   * "is a teammate" would have thrown away exactly the distinction they are making.
   */
  authorTeams: string[];
}

/**
 * Everything one person's inbox holds, as of one moment.
 *
 * A whole snapshot rather than a set of rows, because that is how it is produced: one GraphQL
 * query answers the complete truth for a user, and there is nothing to merge incrementally. The
 * refresher replaces it; the endpoint reads it.
 */
export interface InboxSnapshot {
  userId: string;
  refreshedAt: Date;
  /**
   * The build settings this was made under, carried rather than inferred.
   *
   * A build filter removes its rows before they are ever written down, so a snapshot is only an
   * answer to the question that produced it. Keeping those filters on it is what lets the store
   * file it where it will be found again - see InboxStoreService. The view filters are not here
   * because they had no say in what was written.
   */
  filters: InboxBuildFilters;
  /**
   * Already in piles, because what splits them is facts about the pull request that the reader
   * cannot change without a new answer from GitHub anyway.
   */
  yours: InboxSectionContent[];
  /**
   * Not in piles, and ordered.
   *
   * What splits *these* is facts about the author, and every one of those is a setting somebody
   * can move without anything about GitHub's answer changing. Grouping them here would have
   * meant rebuilding the snapshot to answer a checkbox. So the rows are kept in the order they
   * will be shown in and sorted into headings when they are served - see `groupWaitingOnYou`.
   */
  waitingOnYou: InboxStoredPullRequest[];
  /**
   * The viewer's teams, or null where GitHub would not say - which is a missing permission as
   * often as it is an outage, and either way is "not established" rather than "you are in none".
   */
  teams: ViewerTeam[] | null;
}
