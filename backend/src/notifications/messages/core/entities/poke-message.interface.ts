import {
  GithubNotificationNormalized,
  GithubReviewVerdict,
} from '../../../core/entities/github-notification.interface';

/**
 * Somebody who has reviewed the pull request without settling the request, since the poke went
 * out.
 *
 * By id as well as by handle, for the reason everything about people is: the id is what says
 * whether the next such review is from the same person, and whether it is from the reader.
 *
 * Usually somebody who commented without deciding. Under the strict setting it is also somebody
 * who did decide while GitHub went on asking the reader anyway, and the verdict says which.
 */
export interface PokeMessageReviewer {
  githubId?: string;
  login?: string;
  verdict?: GithubReviewVerdict;
}

export class PokeMessageNormalized {
  id: string;
  userId: string;
  userGithubId?: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  notification: GithubNotificationNormalized;
  /** In the order they reviewed. Empty until somebody has. */
  reviewers: PokeMessageReviewer[];
}
