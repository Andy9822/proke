import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  InboxFilters,
  normalizeInboxSettings,
} from '../../inbox/core/entities/inbox-filters.interface';
import { TokenCipherService } from '../../shared/crypto/token-cipher.service';
import { UserEntity } from '../core/entities/user.entity';
import { UserNormalized } from '../core/entities/user.interface';
import { UserSerializer } from '../core/entities/user.serializer';

/** One person the warmer should build an inbox for, and the settings to build it under. */
export interface InboxWarmTarget {
  userId: string;
  settings: InboxFilters;
}

@Injectable()
export class UserReadService {
  constructor(
    @InjectModel(UserEntity.name) private userModel: Model<UserEntity>,
    private readonly tokenCipher: TokenCipherService,
  ) {}

  public async readByIdOrThrow(id: string): Promise<UserNormalized> {
    const user = await this.readById(id);

    if (!user) {
      throw new NotFoundException(`User not found`);
    }

    return user;
  }

  /**
   * Null where there is no such user. For the paths that hold a user id off a row of their own
   * and have a sensible answer to it having gone stale - unlike a request on their behalf,
   * which has none and throws above.
   */
  public async readById(id: string): Promise<UserNormalized | null> {
    const user = await this.userModel.findById(id).lean<UserEntity>().exec();

    return user ? this.normalize(user) : null;
  }

  public async readByGithubId(githubId: string): Promise<UserNormalized | null> {
    const user = await this.userModel.findOne({ githubId }).lean<UserEntity>().exec();

    return user ? this.normalize(user) : null;
  }

  /**
   * Only for resolving @mentions, which arrive as a handle with no id attached. Every other
   * route into a user goes by githubId, which GitHub never reuses.
   *
   * Matched on the stored lowercase copy rather than a case-insensitive regex over the original.
   * The regex could not use the index - Mongo cannot serve a case-insensitive pattern from a
   * btree - so every mention in every webhook was a full scan of the collection. An indexed
   * equality also has no pattern to escape, which retires the ReDoS guard that came with it.
   */
  public async readByGithubLogin(githubLogin: string): Promise<UserNormalized | null> {
    const user = await this.userModel
      .findOne({ githubLoginLower: githubLogin.toLowerCase() })
      .lean<UserEntity>()
      .exec();

    return user ? this.normalize(user) : null;
  }

  /**
   * Everybody whose inbox is worth keeping ready: asked for it since `usedSince`, and still
   * holding a token.
   *
   * A projection rather than normalised users, deliberately. The inbox warmer asks this every
   * five minutes, and the two things it needs are a date and a settings object - so normalising
   * would put every stored GitHub token through the cipher to answer neither of them.
   *
   * `$exists` and `$ne: null` together rather than either alone: clearGithubAccessToken unsets
   * the field, while a row that never had one has it absent, and both must be excluded.
   */
  public async readInboxWarmTargets(usedSince: Date): Promise<InboxWarmTarget[]> {
    const users = await this.userModel
      .find({
        inboxLastUsedAt: { $gte: usedSince },
        githubAccessToken: { $exists: true, $ne: null },
      })
      .select({ _id: 1, inboxSettings: 1 })
      .lean<Pick<UserEntity, '_id' | 'inboxSettings'>[]>()
      .exec();

    return users.map((user) => ({
      userId: user._id.toString(),
      settings: normalizeInboxSettings(user.inboxSettings),
    }));
  }

  private normalize(user: UserEntity): UserNormalized {
    return UserSerializer.normalize(user, (value) => this.tokenCipher.decrypt(value));
  }
}
