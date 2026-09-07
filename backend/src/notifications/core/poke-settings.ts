import { ALL_NOTIFICATION_TYPES, NotificationType } from './entities/notification-type.enum';

/**
 * When a review request poke is struck through, once somebody other than the reader reviews.
 *
 * `any_review`: the first verdict from anybody settles it. A pull request somebody has already
 * looked at is one the rest of the queue can stop worrying about, which is the right answer for
 * most teams and is what every account starts on.
 *
 * `strict`: only once GitHub itself no longer lists the reader - or the team the request came
 * through - as a requested reviewer. Where a repository wants two approvals, or a codeowner's
 * review is required whatever anybody else said, the first approval is not the end of the ask,
 * and a message struck through at that point is a lie in the other direction.
 *
 * Neither changes what the reader's own review does, or what a merge does: those end the request
 * for everybody.
 */
export const REVIEW_REQUEST_RESOLUTIONS = ['any_review', 'strict'] as const;

export type ReviewRequestResolution = (typeof REVIEW_REQUEST_RESOLUTIONS)[number];

export function isReviewRequestResolution(value: unknown): value is ReviewRequestResolution {
  return REVIEW_REQUEST_RESOLUTIONS.includes(value as ReviewRequestResolution);
}

/**
 * What somebody has switched off, everywhere - and the one thing they can turn up.
 *
 * ## Why this stores the noes rather than the yeses
 *
 * Because the default is everything, and a list of what somebody wants would freeze today's
 * idea of "everything" at the moment they first touched a switch - so a type added next month
 * would arrive muted for every existing user, silently, and the only evidence would be pokes
 * that stopped coming. The same trap SubscriptionWriteService.create sidesteps by not writing a
 * type list on insert.
 *
 * Stored the other way round, a row that has never been written means nothing is muted, a row
 * that mutes one thing says exactly that, and a new type is on for everybody without a
 * migration or a backfill. The cost is that "mute everything" is the one setting that has to be
 * written out in full, which is the rare case rather than the universal one.
 *
 * The review request setting follows the same rule from the other side: what is stored is the
 * departure from the default, and a row without it - every row written before the setting
 * existed - reads as the default.
 *
 * ## Why it lives on the user rather than on the subscription
 *
 * Because it is a fact about the person, not about any one organisation. It rides along on the
 * profile - which the client reads before it renders anything - so the dashboard opens on the
 * real settings with no request of its own, and the webhook router already holds the user by
 * the time it needs them, so consulting these costs no lookup at all on the delivery path.
 */
export interface PokeSettings {
  mutedTypes: NotificationType[];
  reviewRequestResolution: ReviewRequestResolution;
}

/** Opting in is already an explicit act; the useful default afterwards is everything. */
export const DEFAULT_POKE_SETTINGS: PokeSettings = {
  mutedTypes: [],
  reviewRequestResolution: 'any_review',
};

/**
 * The settings as they sit on the user row: absent for anybody who has never moved a switch,
 * and plain strings rather than members of the enum.
 *
 * Loose on purpose, exactly like InboxStoredSettings - a value written by a newer deploy than
 * this one, or by an older one that still had a type this one has retired, has to read as
 * something rather than reaching the router.
 */
export interface PokeStoredSettings {
  mutedTypes?: string[];
  reviewRequestResolution?: string;
}

/**
 * Fills in what a stored row leaves unsaid, and drops what it should not have said.
 *
 * Unrecognised values go rather than being trusted: a retired type cannot be allowed to match
 * anything, and - because this list is a *deny* list - a value nobody can spell any more would
 * otherwise sit there muting a type that no longer exists. Dropping it is also what makes
 * retiring a type free: `team_mention` in an old row simply stops meaning anything.
 *
 * A review request setting this deploy does not know reads as the default for the same reason:
 * whatever it meant, it cannot mean it here.
 */
export function normalizePokeSettings(stored: PokeStoredSettings | null | undefined): PokeSettings {
  const muted = (stored?.mutedTypes ?? []).filter((value): value is NotificationType =>
    ALL_NOTIFICATION_TYPES.includes(value as NotificationType),
  );
  const resolution = stored?.reviewRequestResolution;

  return {
    mutedTypes: [...new Set(muted)],
    reviewRequestResolution: isReviewRequestResolution(resolution)
      ? resolution
      : DEFAULT_POKE_SETTINGS.reviewRequestResolution,
  };
}

/**
 * The account-wide answer to "does this kind of poke reach this person at all".
 *
 * Deliberately the whole of what this file decides about delivery. Where a poke is allowed to
 * come *from* is a subscription's business - see isNotificationAllowed - and the two are
 * combined by intersection at the one place that has both: an organisation can narrow what
 * somebody receives, never widen it past what they asked for here.
 */
export function isPokeTypeMuted(settings: PokeSettings, type: NotificationType): boolean {
  return settings.mutedTypes.includes(type);
}

/**
 * Whether somebody else's verdict leaves this person's review request standing while GitHub
 * still asks them for one. The other half of that condition - whether GitHub still does - is
 * the resolution's to check; this only says whether it is worth checking.
 */
export function keepsReviewRequestWhileAsked(settings: PokeSettings): boolean {
  return settings.reviewRequestResolution === 'strict';
}
