import { NotificationType } from './notification-type.enum';

/**
 * How big the change is. Two numbers rather than a total, because "+400 −4" and "+202 −202" are
 * the same total and completely different asks.
 */
export interface GithubDiffStat {
  additions: number;
  deletions: number;
}

/**
 * The comments a review arrived with, once several pokes have been folded into one.
 *
 * A count rather than the comments themselves: the message quotes exactly one of them and links
 * to the review for the rest, so carrying the others would be carrying them nowhere.
 */
/**
 * The review states that are a verdict on the change, as opposed to somebody talking about it.
 *
 * A review that is neither is an envelope: GitHub opens one behind every set of inline comments,
 * including the single comment left outside a review, and where it carries no words of its own
 * there is nothing in it to report beyond the comments themselves.
 */
export const REVIEW_VERDICTS = ['approved', 'changes_requested'] as const;

export type GithubReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function isReviewVerdict(state: string | undefined): state is GithubReviewVerdict {
  return REVIEW_VERDICTS.includes(state as GithubReviewVerdict);
}

export interface GithubNotificationComments {
  count: number;
  /**
   * Whether they named the recipient rather than merely landing on their pull request. Being
   * mentioned is why somebody is being poked, and must not be flattened into "left 3 comments".
   */
  mentioned: boolean;
}

export interface GithubNotificationNormalized {
  type: NotificationType;
  title: string;
  repositoryFullName: string;
  // Webhook payloads carry a real html_url, unlike the Notifications API which only ever
  // handed back api.github.com links.
  htmlUrl: string;
  actorLogin: string;
  /** The #number. How people refer to a pull request or an issue when they talk about it. */
  number?: number;
  /**
   * `approved`, `changes_requested` or `commented`, on a submitted review only. The type says
   * a review happened; this says whether it was good news.
   */
  reviewState?: string;
  /**
   * What the person actually wrote - the comment, the review, the description they mentioned
   * you in. Absent where no words were involved: a review request and a merge are events, not
   * messages, and inventing a quote for them would be misleading.
   *
   * Full length and unformatted. How much of it to show is the destination's business.
   */
  excerpt?: string;
  /** `org/team`, on a team mention only - the recipient was named as part of a group. */
  teamHandle?: string;
  /**
   * The avatar of whoever owns the repository - an organisation's logo, or a person's face for
   * a repository they own themselves. Recognised far faster than the name beside it is read.
   */
  ownerAvatarUrl?: string;
  /**
   * Pull requests only, and only where we could establish it. Webhooks carry the line counts on
   * `pull_request` events and on no others, so a poke about a comment has to go and ask.
   */
  diff?: GithubDiffStat;
  /**
   * Whether the thing is a pull request rather than an issue. A team mention can be either, and
   * only a pull request has a diff worth asking GitHub for.
   */
  isPullRequest?: boolean;
  /**
   * Which review this belongs to, on the two events a review is delivered as - the submission
   * itself, and one per inline comment. GitHub puts the same id on all of them, which is what
   * lets a review that arrived as six webhooks leave as one poke.
   */
  reviewId?: string;
  /**
   * The inline comment this came from, absent on the review submission itself. Sorts the
   * comments back into the order they were written, since webhooks do not arrive in one.
   */
  commentId?: string;
  /**
   * Whether the person being poked is the one who opened the thread, on a reply only.
   *
   * The type says somebody answered in a thread you are in; this says whether the comment they
   * answered was yours. That is the difference between "replied to you" and "also replied", and
   * the only thing separating the two kinds of person a reply reaches - so it is set per
   * recipient rather than per event, and one reply goes out carrying both values.
   */
  threadStarter?: boolean;
  /**
   * What the rest of the review held, set only where a poke stands for more than one event.
   * Absent means this poke is about exactly one thing, which is every poke that was never
   * batched with anything.
   */
  comments?: GithubNotificationComments;
  /**
   * When GitHub's webhook reached us, as epoch millis. Carried purely so delivery can measure
   * how long the poke took to arrive, which is the one number that describes the promise this
   * product makes and the one nothing else here could answer - the endpoint acknowledges in a
   * millisecond and does the work detached, so response time says nothing about it.
   *
   * Absent on the two synthetic messages, which come from a button rather than from GitHub, and
   * on any poke rebuilt from a stored row - by then the number would describe a webhook from
   * hours ago rather than the edit being sent.
   */
  receivedAt?: number;
}

/**
 * What can make a review request stop being true.
 *
 * A superset of the verdicts: a review settles a request, and so does the pull request going
 * away underneath it, and so does whoever asked taking the ask back. A comment-only review is
 * deliberately absent - GitHub leaves the request pending when somebody reviews without
 * deciding, and so should the message.
 */
export const POKE_RESOLUTIONS = [...REVIEW_VERDICTS, 'merged', 'closed', 'removed'] as const;

export type PokeResolutionKind = (typeof POKE_RESOLUTIONS)[number];

/**
 * Who GitHub still lists as asked for a review, after the event that carried it.
 *
 * Straight off the payload: every review and every pull request event carries both lists, in
 * the state the pull request is in once the event has happened - so a reviewer who has just
 * reviewed is already off it. What it answers is whether one particular reader is still on the
 * hook, which is the question a strict review request turns on and a removal has to ask too.
 */
export interface PokeRequestedReviewers {
  githubIds: string[];
  /** `org/slug`, lowercased, so it compares to what a team poke carries. */
  teamHandles: string[];
}

/**
 * Somebody who has reviewed the pull request without settling the request, as a review request
 * poke names them.
 *
 * Deliberately not a resolution. GitHub leaves the request pending when a reviewer only
 * comments, and so does the message - but a poke that says "this is waiting on you" is worth a
 * line saying somebody is already there, because that is the difference between a pull request
 * nobody has opened and one that wants a second opinion.
 *
 * No `bySelf`, unlike a resolution: the line exists to tell the reader about other people, and
 * their own comments are not news to them, so they are never put on it.
 */
export interface PokeReviewer {
  /** Absent only if GitHub sent us a review with no user on it. */
  login?: string;
  /**
   * What they decided, where the request stood anyway. Absent on a comment-only review, which
   * is the ordinary case. Set where the reader keeps the request as long as GitHub keeps asking
   * them - see ReviewRequestResolution - and somebody else's verdict came in meanwhile: whether
   * the person ahead of you approved or blocked is exactly what decides whether to open it now.
   */
  verdict?: GithubReviewVerdict;
}

/** Why a review request poke is being struck through, and by whom. */
export interface PokeResolution {
  kind: PokeResolutionKind;
  /** Whoever did it. Absent only if GitHub sent us an event with no actor on it. */
  actorLogin?: string;
  /**
   * Whether that was the person reading the message. "you approved this" and "approved by @ada"
   * are the same fact, and only one of them is worth reading about yourself.
   */
  bySelf: boolean;
}
