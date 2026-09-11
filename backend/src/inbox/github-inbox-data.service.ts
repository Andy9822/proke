import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../analytics/metrics.service';
import { githubFetch } from '../shared/http/github-fetch';

/**
 * What GitHub says about one pull request, before anything has decided where it belongs.
 *
 * Richer than InboxPullRequest on purpose - the extra fields exist only so the classifier can
 * bucket and order the row, and none of them leaves this module.
 */
export interface GithubInboxPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /**
   * GitHub's own `updatedAt`, and what every section is ordered by.
   *
   * Bumped by a push, a comment, a title edit, a label - anything that touches the pull request.
   * Which is looser than "the last push" and is deliberately not narrowed: the closest thing to
   * a real last-push timestamp is the head commit's `committedDate`, and that costs a commit
   * node per row and still lies after a rebase. This is the field GitHub sorts its own lists by,
   * and it answers the question the ordering is actually asking - what moved most recently.
   */
  updatedAt: string;
  /**
   * When it was opened, and the clock the digest ages rows by. Not `updatedAt`, which moves on
   * every comment, so the row argued about hardest would read as the newest.
   */
  createdAt: string;
  changedFiles: number;
  repositoryId: string;
  repositoryFullName: string;
  authorLogin: string;
  authorAvatarUrl?: string;
  /** GitHub calls a GitHub App's account a Bot. The suffix check is the belt to that brace. */
  authorIsBot: boolean;
  /**
   * APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED, or absent where GitHub has no opinion.
   *
   * Asked for on both halves. On yours it decides the section; on somebody else's it is what the
   * "already approved" filter reads, and it is GitHub's decision for the pull request rather
   * than a record of whether you personally reviewed it.
   */
  reviewDecision?: string;
  /** Whether any review thread is still open. Only asked for on the viewer's own pull requests. */
  hasUnresolvedThreads: boolean;
}

export interface GithubInbox {
  viewerLogin: string;
  yours: GithubInboxPullRequest[];
  waitingOnYou: GithubInboxPullRequest[];
}

/** GitHub rejects the token. Its own type so callers can say which credential died. */
export class GithubInboxTokenRejectedError extends Error {
  constructor() {
    super('GitHub rejected the stored access token');
    this.name = 'GithubInboxTokenRejectedError';
  }
}

/** Past this many of your own open pull requests, the sections stop being a list of work. */
const MAX_YOURS = 50;
const MAX_WAITING = 50;
/** Enough to answer "is anything still open" without paying for a hundred nodes per row. */
const MAX_THREADS = 30;

/**
 * Both halves of the inbox, in one request.
 *
 * GraphQL rather than REST for one reason that matters: the review decision, the thread states
 * and the repository all arrive with the search results, where REST would need a follow-up call
 * per pull request. Measured against a real account this costs a single point of the 5,000 an
 * hour a user has - so the refresher this is built for can run every minute and spend about
 * one percent of one person's budget doing it.
 *
 * The budget is per user and not pooled: user-to-server requests bill the authenticated user,
 * shared with whatever else acts on their behalf, and never the organisation. Which is the whole
 * argument for asking as the user here rather than as the installation - that, and the fact that
 * GitHub then applies their visibility for us and we do not have to reimplement it.
 *
 * What a user token can see is the intersection of what they can reach and where this app is
 * installed. A private repository in an org without proke is invisible, silently, and the client
 * says so rather than pretending the list is everything.
 */
@Injectable()
export class GithubInboxDataService {
  private readonly logger = new Logger(GithubInboxDataService.name);

  constructor(private readonly metrics: MetricsService) {}

  /** Null where GitHub could not be asked. Never an empty inbox - those read very differently. */
  public async read(accessToken: string): Promise<GithubInbox | null> {
    let response: Response;

    try {
      response = await githubFetch(
        this.metrics,
        'graphql_inbox',
        'https://api.github.com/graphql',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: INBOX_QUERY,
            variables: { yours: MAX_YOURS, waiting: MAX_WAITING, threads: MAX_THREADS },
          }),
        },
      );
    } catch (error) {
      this.logger.warn(`Could not reach GitHub for an inbox: ${error}`);
      return null;
    }

    if (response.status === 401) {
      throw new GithubInboxTokenRejectedError();
    }

    if (!response.ok) {
      this.logger.warn(`GitHub answered ${response.status} for an inbox query`);
      return null;
    }

    const body = await response.json();

    // GraphQL reports most failures with a 200 and an errors array, so the status is no help.
    // Partial data is still data: a search that failed for one half should not lose the other.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      this.logger.warn(
        `GitHub returned GraphQL errors for an inbox: ${body.errors
          .map((error: any) => error?.message)
          .join('; ')}`,
      );
    }

    const viewerLogin = body?.data?.viewer?.login;

    if (!viewerLogin) {
      return null;
    }

    return {
      viewerLogin,
      yours: normalizeSearch(body?.data?.yours),
      waitingOnYou: normalizeSearch(body?.data?.waitingOnYou),
    };
  }
}

function normalizeSearch(search: any): GithubInboxPullRequest[] {
  if (!Array.isArray(search?.nodes)) {
    return [];
  }

  return search.nodes
    .filter((node: any) => node?.id && node?.repository?.nameWithOwner)
    .map((node: any): GithubInboxPullRequest => {
      const login = node.author?.login ?? 'ghost';

      return {
        id: node.id,
        number: node.number,
        title: node.title ?? '',
        url: node.url ?? '',
        isDraft: Boolean(node.isDraft),
        updatedAt: node.updatedAt ?? '',
        createdAt: node.createdAt ?? '',
        changedFiles: Number(node.changedFiles ?? 0),
        repositoryId: node.repository.id,
        repositoryFullName: node.repository.nameWithOwner,
        authorLogin: login,
        authorAvatarUrl: node.author?.avatarUrl,
        authorIsBot: node.author?.__typename === 'Bot' || /\[bot\]$/i.test(login),
        reviewDecision: node.reviewDecision ?? undefined,
        hasUnresolvedThreads: Boolean(
          node.reviewThreads?.nodes?.some((thread: any) => thread?.isResolved === false),
        ),
      };
    });
}

/**
 * `archived:false` because a pull request in an archived repository cannot be merged or reviewed,
 * and `is:pr` because a GitHub App user token is refused a search that could return both issues
 * and pull requests.
 *
 * Only the viewer's own half asks for review threads. On somebody else's pull request the state
 * of their threads is not what decides where the row goes, and thirty nodes each would be the
 * most expensive thing in the query for no answer. The review decision is in the shared fragment
 * instead - it is one scalar, and both halves have a use for it.
 *
 * The "already approved" filter is applied after this rather than as a `-review:approved` in the
 * search, unlike the draft rule below. The reasons are not symmetric: `draft:false` is a
 * qualifier this query has always used and is known to work, where a search GitHub rejects for
 * a malformed qualifier loses the entire half - and a filter that is on by default would lose it
 * for everybody. Thirty rows of budget occasionally spent on pull requests that are then dropped
 * is the cheaper mistake.
 *
 * `sort:updated-desc` on both halves, matching the order the sections are drawn in. It changes
 * nothing about what the reader sees while both lists fit under the page limits - the classifier
 * sorts what it is given regardless - and everything about *which* fifty come back once one does
 * not. Truncating by best-match and then displaying by recency would drop rows off the bottom of
 * the query that belong at the top of the page.
 *
 * `draft:false` on that half too, and only that half. Your own drafts are worth a pile - they
 * are the work you have started and not sent - but somebody else's draft is not waiting on you,
 * whatever GitHub says about the review request sitting on it. Excluded in the search rather
 * than after it so the page limit is spent on rows that will be shown.
 */
const INBOX_QUERY = `
query Inbox($yours: Int!, $waiting: Int!, $threads: Int!) {
  viewer { login }
  yours: search(
    query: "is:open is:pr author:@me archived:false sort:updated-desc"
    type: ISSUE
    first: $yours
  ) {
    nodes {
      ... on PullRequest {
        ...Row
        reviewThreads(first: $threads) { nodes { isResolved } }
      }
    }
  }
  waitingOnYou: search(
    query: "is:open is:pr review-requested:@me archived:false draft:false sort:updated-desc"
    type: ISSUE
    first: $waiting
  ) {
    nodes { ... on PullRequest { ...Row } }
  }
}

fragment Row on PullRequest {
  id
  number
  title
  url
  isDraft
  updatedAt
  createdAt
  changedFiles
  reviewDecision
  repository { id nameWithOwner }
  author { __typename login avatarUrl }
}
`;
