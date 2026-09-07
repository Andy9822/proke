import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GithubNotificationNormalized } from '../../core/entities/github-notification.interface';
import { PokeMessageEntity } from '../core/entities/poke-message.entity';
import { PokeMessageReviewer } from '../core/entities/poke-message.interface';

export interface PokeMessageRememberDto {
  userId: string;
  userGithubId?: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  notification: GithubNotificationNormalized;
}

@Injectable()
export class PokeMessageWriteService {
  constructor(
    @InjectModel(PokeMessageEntity.name) private messageModel: Model<PokeMessageEntity>,
  ) {}

  /**
   * Where a review request landed in Slack.
   *
   * An upsert, so a review requested a second time points at the second message. The first one
   * is then unreachable and will never be struck through - which is correct, because it is a
   * message about a request that has since been made again, and the live one is the new one.
   *
   * Whoever had reviewed by then goes with the old message. The new one was rendered without
   * them, and the row has to say what the message says.
   */
  public async remember(dto: PokeMessageRememberDto): Promise<void> {
    await this.messageModel.updateOne(
      {
        userId: dto.userId,
        repositoryFullName: dto.repositoryFullName,
        pullRequestNumber: dto.pullRequestNumber,
      },
      {
        $set: {
          userGithubId: dto.userGithubId,
          teamId: dto.teamId,
          channelId: dto.channelId,
          messageTs: dto.messageTs,
          notification: dto.notification,
        },
        $unset: { reviewers: '' },
      },
      { upsert: true },
    );
  }

  /**
   * Notes that somebody has reviewed the pull request without settling the request.
   *
   * Named once however many times they review, and carrying the strongest thing they have said:
   * a verdict after a comment moves them from 💬 to ✅ where they already stand, so the line keeps
   * the order people reviewed in rather than sending them to the end of it. Somebody not yet on
   * the line is added with an add-to-set, which is what makes the same review delivered twice a
   * no-op.
   *
   * Deliberately without touching the timestamps: the TTL is how long the request is worth
   * editing, and a comment on the pull request does not make the request to review it any
   * younger.
   */
  public async addReviewer(id: string, reviewer: PokeMessageReviewer): Promise<void> {
    const identity = identityOf(reviewer);

    // Only where there is a verdict to write and a person to write it against. A reviewer with
    // neither id nor handle matches nobody - and `$elemMatch: {}` would match everybody.
    if (reviewer.verdict && identity) {
      const result = await this.messageModel
        .updateOne(
          { _id: id, reviewers: { $elemMatch: identity } },
          { $set: { 'reviewers.$.verdict': reviewer.verdict } },
          { timestamps: false },
        )
        .exec();

      if (result.matchedCount > 0) {
        return;
      }
    }

    await this.messageModel
      .updateOne(
        { _id: id },
        { $addToSet: { reviewers: compact(reviewer) } },
        { timestamps: false },
      )
      .exec();
  }

  /** Settled, or unsettleable. Either way there is nothing left to go back and edit. */
  public async delete(id: string): Promise<void> {
    await this.messageModel.deleteOne({ _id: id }).exec();
  }

  public async deleteForUser(userId: string): Promise<void> {
    await this.messageModel.deleteMany({ userId }).exec();
  }
}

/**
 * What finds a reviewer among the ones already on the row. By id where there is one, which
 * survives a rename; by handle where GitHub gave us nothing better; nothing where it gave
 * neither.
 */
function identityOf(reviewer: PokeMessageReviewer): Record<string, string> | undefined {
  if (reviewer.githubId) {
    return { githubId: reviewer.githubId };
  }

  return reviewer.login ? { login: reviewer.login } : undefined;
}

/**
 * Without the keys that hold nothing. $addToSet compares whole documents, so `{ login }` and
 * `{ githubId: undefined, login }` would be two different people to it - and which of the two
 * gets written depends on what the driver makes of an undefined.
 */
function compact(reviewer: PokeMessageReviewer): PokeMessageReviewer {
  return {
    ...(reviewer.githubId ? { githubId: reviewer.githubId } : {}),
    ...(reviewer.login ? { login: reviewer.login } : {}),
    ...(reviewer.verdict ? { verdict: reviewer.verdict } : {}),
  };
}
