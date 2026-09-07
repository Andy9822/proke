import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { InboxStoredSettings } from '../../../inbox/core/entities/inbox-filters.interface';
import { PokeStoredSettings } from '../../../notifications/core/poke-settings';
import { AuthMethod } from '../enum/auth-method.enum';

/**
 * How somebody has set up their inbox, as stored.
 *
 * Every field optional and filled from the defaults on read - see normalizeInboxSettings -
 * which is what lets a filter be added without a migration, the same way subscription
 * preferences work. `recentDrafts` is a plain string here and checked against the closed set on
 * the way out, so a value an older or newer deploy wrote reads as the default rather than as
 * something the classifier has to cope with.
 */
@Schema({ _id: false })
export class InboxSettingsEntity implements InboxStoredSettings {
  @Prop()
  includeApproved?: boolean;

  @Prop()
  recentDrafts?: string;

  @Prop()
  separateTeam?: boolean;

  @Prop()
  separateBots?: boolean;

  @Prop({ type: [String], default: undefined })
  excludedTeams?: string[];

  @Prop({ type: [String], default: undefined })
  ignoredAuthors?: string[];
}

export const InboxSettingsSchema = SchemaFactory.createForClass(InboxSettingsEntity);

/**
 * What somebody has switched off about pokes, as stored.
 *
 * One field, and a list of the noes rather than the yeses - see PokeSettings for why that way
 * round is the only one that lets a notification type be added without muting it for everybody
 * who was already here. Absent for anyone who has never moved a switch, which is the same
 * answer as an empty list: nothing muted, everything on.
 */
@Schema({ _id: false })
export class PokeSettingsEntity implements PokeStoredSettings {
  // Plain strings, checked against the enum on the way out, so a value written by another
  // deploy - or one this deploy has since retired - reads as nothing rather than as a mute.
  @Prop({ type: [String], default: undefined })
  mutedTypes?: string[];

  // The same looseness for the same reason. Absent for every row written before the setting
  // existed, which reads as the default - and a value this deploy cannot spell reads as it too.
  @Prop()
  reviewRequestResolution?: string;
}

export const PokeSettingsSchema = SchemaFactory.createForClass(PokeSettingsEntity);

@Schema({ collection: 'users', timestamps: true })
export class UserEntity {
  _id: Types.ObjectId;

  // GitHub's numeric user id, as a string. This is the identity: it never changes and GitHub
  // never reuses it, unlike the email or the login. Sparse so pre-GitHub rows don't collide.
  @Prop({ unique: true, sparse: true })
  githubId?: string;

  // The @handle, as GitHub cases it. Display only - it changes whenever the user renames
  // themselves, so githubId stays the identity.
  @Prop()
  githubLogin?: string;

  // The same handle, lowercased, and the field mention routing actually queries. GitHub treats
  // handles case-insensitively, so this is what makes that an indexed equality rather than a
  // case-insensitive regex, which Mongo cannot serve from an index at all.
  //
  // Unique because GitHub itself guarantees one live owner per handle. Two rows claiming one
  // handle only ever means a stale row left behind by a rename, and that is exactly the state
  // that used to let a poke - repository name, title, and a slice of the comment - land on
  // whoever the unordered findOne happened to return. UserWriteService releases the handle from
  // any other row before claiming it here, which is what keeps this index satisfiable.
  @Prop({ unique: true, sparse: true })
  githubLoginLower?: string;

  // Kept for display and as the future join key to other platforms. Optional: GitHub only
  // hands one over if the user has a verified primary address.
  @Prop()
  email?: string;

  @Prop()
  authMethod?: AuthMethod;

  @Prop()
  avatarUrl?: string;

  // The GitHub App user-to-server token. Notifications arrive by webhook, so this is only used
  // to ask GitHub which installations the user can reach and what their role in an org is.
  //
  // Encrypted at rest by TokenCipherService, the same key that guards the Slack bot tokens, and
  // deliberately absent from UserSerializer.serialize() so it can never leave through the API.
  // Encrypted regardless of how narrow today's scopes are: the app's user permissions are
  // widened on GitHub's settings page, not in this file, so nobody making that change would
  // ever see a note here telling them to come back and encrypt it.
  @Prop()
  githubAccessToken?: string;

  @Prop({ type: Date })
  lastActivityDate: Date;

  // How they have set their inbox up. Absent for anyone who has never moved a switch, and read
  // as the defaults. Here rather than in the browser or the address bar so it is the same inbox
  // on every device - and so the warmer can build the view the page is going to open on without
  // anybody telling it which one that is.
  @Prop({ type: InboxSettingsSchema })
  inboxSettings?: InboxSettingsEntity;

  // Which kinds of poke they have turned off, for every organisation at once. Here rather than
  // on each subscription because it is a fact about the person: somebody who does not want to
  // hear about merges does not want to hear about them anywhere. A subscription can still
  // narrow further; nothing can widen past this.
  @Prop({ type: PokeSettingsSchema })
  pokeSettings?: PokeSettingsEntity;

  // When they last asked for their inbox to be refreshed. Stamped by POST /inbox/refresh, which
  // the page calls on opening and whenever a build filter moves, and read by the warmer's
  // activity gate. Not `lastActivityDate`, which any request stamps: plenty of people use proke
  // for pokes and never open the inbox, and their inbox is not worth a GitHub query every five
  // minutes.
  @Prop({ type: Date })
  inboxLastUsedAt?: Date;

  @Prop()
  createdAt: Date;

  @Prop()
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<UserEntity>;

export const UserSchema = SchemaFactory.createForClass(UserEntity);

// The warmer's one query is a range over this, every five minutes, across every user there is.
// Sparse because most rows never get the field, and a row without it can never match a `$gte`.
UserSchema.index({ inboxLastUsedAt: 1 }, { sparse: true });
