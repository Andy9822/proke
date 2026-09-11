import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  InboxFilters,
  normalizeInboxSettings,
} from '../../inbox/core/entities/inbox-filters.interface';
import { normalizePokeSettings } from '../../notifications/core/poke-settings';
import { TokenCipherService } from '../../shared/crypto/token-cipher.service';
import { isTimezone } from '../../shared/time/local-day';
import { UserEntity } from '../core/entities/user.entity';
import { UserNormalized } from '../core/entities/user.interface';
import { UserSerializer } from '../core/entities/user.serializer';

/** One person the warmer should build an inbox for, and the settings to build it under. */
export interface InboxWarmTarget {
  userId: string;
  settings: InboxFilters;
}

/** One person who has asked for a digest, and what it takes to decide whether one is due. */
export interface DigestTarget {
  userId: string;
  timezone: string;
  hour: number;
  /** The local day their last digest was claimed for. The claim still decides; this saves a write. */
  sentOn?: string;
  /** Their inbox settings, so the digest lists what their inbox would. */
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

  /**
   * Everybody who has turned the digest on and still holds a token. Whose hour has come is the
   * sweep's question, not Mongo's - it cannot evaluate a timezone. Projected for the reason the
   * warmer's targets are: normalising would decrypt every stored token to answer it.
   */
  public async readDigestTargets(): Promise<DigestTarget[]> {
    const users = await this.userModel
      .find({
        'pokeSettings.digestEnabled': true,
        githubAccessToken: { $exists: true, $ne: null },
      })
      .select({ _id: 1, pokeSettings: 1, timezone: 1, digestSentOn: 1, inboxSettings: 1 })
      .lean<
        Pick<UserEntity, '_id' | 'pokeSettings' | 'timezone' | 'digestSentOn' | 'inboxSettings'>[]
      >()
      .exec();

    return users.flatMap((user) => {
      // Without a zone there is no hour to be due at.
      if (!isTimezone(user.timezone)) {
        return [];
      }

      return [
        {
          userId: user._id.toString(),
          timezone: user.timezone,
          hour: normalizePokeSettings(user.pokeSettings).digestHour,
          sentOn: user.digestSentOn,
          settings: normalizeInboxSettings(user.inboxSettings),
        },
      ];
    });
  }

  private normalize(user: UserEntity): UserNormalized {
    return UserSerializer.normalize(user, (value) => this.tokenCipher.decrypt(value));
  }
}
