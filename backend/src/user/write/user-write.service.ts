import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, UpdateQuery } from 'mongoose';
import {
  InboxFilters,
  normalizeInboxSettings,
} from '../../inbox/core/entities/inbox-filters.interface';
import {
  PokeSettings,
  PokeSettingsUpdate,
  normalizePokeSettings,
} from '../../notifications/core/poke-settings';
import { TokenCipherService } from '../../shared/crypto/token-cipher.service';
import { isTimezone, localMomentIn } from '../../shared/time/local-day';
import { UserEntity } from '../core/entities/user.entity';
import { UserNormalized } from '../core/entities/user.interface';
import { UserSerializer } from '../core/entities/user.serializer';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * How stale `lastActivityDate` is allowed to get. Writing it on every authenticated request
 * would be a database write per request to store something nobody reads to the minute.
 */
const ACTIVITY_RESOLUTION_MS = 60 * 60 * 1000;

@Injectable()
export class UserWriteService {
  constructor(
    @InjectModel(UserEntity.name) private userModel: Model<UserEntity>,
    private readonly tokenCipher: TokenCipherService,
  ) {}

  public async create(dto: CreateUserDto): Promise<UserNormalized> {
    if (dto.githubLogin) {
      await this.releaseGithubLogin(dto.githubLogin);
    }

    const user = await this.userModel.create({
      githubId: dto.githubId,
      githubLogin: dto.githubLogin,
      githubLoginLower: dto.githubLogin?.toLowerCase(),
      email: dto.email,
      authMethod: dto.authMethod,
      avatarUrl: dto.avatarUrl,
      githubAccessToken: this.encryptToken(dto.githubAccessToken),
      lastActivityDate: new Date(),
    });

    return this.normalize(user);
  }

  public async update(dto: UpdateUserDto): Promise<UserNormalized> {
    const updateQuery: UpdateQuery<UserEntity> = {};

    if (dto.githubId) {
      updateQuery.githubId = dto.githubId;
    }

    if (dto.githubLogin) {
      // Whoever is being updated has just proved they own this handle, so any other row still
      // holding it is a leftover from a rename. Released before the claim, or the unique index
      // on githubLoginLower would reject the write.
      await this.releaseGithubLogin(dto.githubLogin, dto.id);

      updateQuery.githubLogin = dto.githubLogin;
      updateQuery.githubLoginLower = dto.githubLogin.toLowerCase();
    }

    if (dto.email) {
      updateQuery.email = dto.email;
    }

    if (dto.authMethod) {
      updateQuery.authMethod = dto.authMethod;
    }

    if (dto.avatarUrl) {
      updateQuery.avatarUrl = dto.avatarUrl;
    }

    if (dto.githubAccessToken) {
      updateQuery.githubAccessToken = this.encryptToken(dto.githubAccessToken);
    }

    const user = await this.userModel.findOneAndUpdate(
      { _id: new Types.ObjectId(dto.id) },
      updateQuery,
      { new: true },
    );

    if (!user) {
      throw new Error(`User with id ${dto.id} not found for update`);
    }

    return this.normalize(user);
  }

  /**
   * Used when GitHub rejects a stored token. update() cannot express this - it skips falsy
   * values by design - and without it a token GitHub has already refused is presented again on
   * every connections page load, forever.
   */
  public async clearGithubAccessToken(userId: string): Promise<void> {
    await this.userModel.updateOne(
      { _id: new Types.ObjectId(userId) },
      { $unset: { githubAccessToken: '' } },
    );
  }

  /**
   * Marks the user as having been seen, at most once an hour.
   *
   * The `$lt` in the filter is what makes that a single unconditional write rather than a read
   * followed by a write: a request inside the window matches nothing and costs one indexed
   * lookup. Called from the auth guard, so it runs on every authenticated request.
   */
  public async recordActivity(userId: string, now: Date = new Date()): Promise<void> {
    await this.userModel.updateOne(
      {
        _id: new Types.ObjectId(userId),
        lastActivityDate: { $lt: new Date(now.getTime() - ACTIVITY_RESOLUTION_MS) },
      },
      { $set: { lastActivityDate: now } },
    );
  }

  /**
   * Replaces how somebody's inbox is set up, whole.
   *
   * Whole rather than merged, because the client always holds and sends the complete set: a
   * setting put back to its default has to overwrite the stored one, and a merge would leave the
   * old value sitting there. Answers with what is now stored, normalised, so the caller draws the
   * truth rather than its own request.
   */
  public async updateInboxSettings(userId: string, settings: InboxFilters): Promise<InboxFilters> {
    const user = await this.userModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(userId) },
        { $set: { inboxSettings: settings } },
        { returnDocument: 'after' },
      )
      .lean<UserEntity>()
      .exec();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return normalizeInboxSettings(user.inboxSettings);
  }

  /**
   * Replaces which kinds of poke somebody has switched off, whole - same contract, same reason
   * as the inbox settings above. Unmuting is spelled by sending a set without that type in it,
   * so a merge would make it unspellable.
   */
  public async updatePokeSettings(
    userId: string,
    settings: PokeSettingsUpdate,
    timezone?: string,
    now: Date = new Date(),
  ): Promise<PokeSettings> {
    // Field by field, not one subdocument: a body that says nothing about the digest leaves it.
    const previous = await this.userModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(userId) },
        {
          $set: {
            'pokeSettings.mutedTypes': settings.mutedTypes,
            'pokeSettings.reviewRequestResolution': settings.reviewRequestResolution,
            ...(settings.digestEnabled === undefined
              ? {}
              : { 'pokeSettings.digestEnabled': settings.digestEnabled }),
            ...(settings.digestHour === undefined
              ? {}
              : { 'pokeSettings.digestHour': settings.digestHour }),
            ...(timezone ? { timezone } : {}),
          },
        },
        { returnDocument: 'before' },
      )
      .lean<UserEntity>()
      .exec();

    if (!previous) {
      throw new NotFoundException('User not found');
    }

    const before = normalizePokeSettings(previous.pokeSettings);
    const after: PokeSettings = {
      mutedTypes: settings.mutedTypes,
      reviewRequestResolution: settings.reviewRequestResolution,
      digestEnabled: settings.digestEnabled ?? before.digestEnabled,
      digestHour: settings.digestHour ?? before.digestHour,
    };

    const switchedOn = after.digestEnabled && !before.digestEnabled;
    // The save that first supplies a zone counts as the switch-on: enabling from a client that
    // sent none claimed nothing, and this one must not fire a digest minutes afterwards. Only
    // that save, though. Any other one made after the hour, before the sweep has been, would
    // otherwise spend the day on a digest that never went.
    const zoneArrived = after.digestEnabled && !previous.timezone && Boolean(timezone);

    if (switchedOn || zoneArrived) {
      await this.claimDigestOnEnable(userId, after.digestHour, timezone ?? previous.timezone, now);
    }

    return after;
  }

  /**
   * Takes one digest per person per day, and answers whether this caller got it.
   *
   * One conditional write rather than a read and a write, so two passes - or two replicas -
   * cannot both find the day unclaimed and both send.
   */
  public async claimDigest(userId: string, localDay: string): Promise<boolean> {
    const result = await this.userModel.updateOne(
      { _id: new Types.ObjectId(userId), digestSentOn: { $ne: localDay } },
      { $set: { digestSentOn: localDay } },
    );

    return result.modifiedCount === 1;
  }

  /** Spends today only where their hour has been, so turning it on at four sends nothing at four. */
  private async claimDigestOnEnable(
    userId: string,
    hour: number,
    timezone: string | undefined,
    now: Date,
  ): Promise<void> {
    if (!isTimezone(timezone)) {
      return;
    }

    const moment = localMomentIn(timezone, now);

    if (moment.hour < hour) {
      return;
    }

    await this.userModel.updateOne(
      { _id: new Types.ObjectId(userId) },
      { $set: { digestSentOn: moment.day } },
    );
  }

  /**
   * Marks the inbox as having been asked for.
   *
   * Unconditional, unlike recordActivity, and that is a difference in how often it is called
   * rather than a difference of opinion: this fires when the page opens or a build filter
   * moves, which is a handful of times a day, so a write per call is cheaper than a guard.
   */
  public async recordInboxUse(userId: string, now: Date = new Date()): Promise<void> {
    await this.userModel.updateOne(
      { _id: new Types.ObjectId(userId) },
      { $set: { inboxLastUsedAt: now } },
    );
  }

  public async delete(userId: string): Promise<void> {
    await this.userModel.deleteOne({ _id: new Types.ObjectId(userId) });
  }

  /**
   * Takes a handle off every row except the one about to claim it.
   *
   * GitHub frees a handle the moment its owner renames, so the previous holder's row can still
   * be carrying it. Only the display copy and its lowercase index key are cleared - the row is
   * a real user, identified by githubId, and stays exactly where it is. They lose nothing but
   * the ability to receive @mentions under a name that is no longer theirs, which is the point.
   */
  private async releaseGithubLogin(githubLogin: string, exceptUserId?: string): Promise<void> {
    const filter: Record<string, unknown> = { githubLoginLower: githubLogin.toLowerCase() };

    if (exceptUserId) {
      filter._id = { $ne: new Types.ObjectId(exceptUserId) };
    }

    await this.userModel.updateMany(filter, {
      $unset: { githubLogin: '', githubLoginLower: '' },
    });
  }

  private encryptToken(token: string | undefined): string | undefined {
    return token ? this.tokenCipher.encrypt(token) : undefined;
  }

  private normalize(user: UserEntity): UserNormalized {
    return UserSerializer.normalize(user, (value) => this.tokenCipher.decrypt(value));
  }
}
