import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsOptional } from 'class-validator';
import { ALL_NOTIFICATION_TYPES, NotificationType } from '../core/entities/notification-type.enum';
import { REVIEW_REQUEST_RESOLUTIONS, ReviewRequestResolution } from '../core/poke-settings';

/**
 * A full replacement, not a patch: unmuting is spelled by sending the set without that type in
 * it, so a merge would make it unspellable.
 *
 * Bounded by the number of types there are, which is the only bound that means anything here -
 * a longer list is either a duplicate or a value the normalizer is about to drop, and neither is
 * worth storing. Values themselves are checked against the enum, so a retired type is a 400
 * rather than a silent no-op, which is the more useful answer to a client that has gone stale.
 */
export class UpdatePokeSettingsBody {
  @ApiProperty({ enum: NotificationType, isArray: true })
  @IsArray()
  @ArrayMaxSize(ALL_NOTIFICATION_TYPES.length)
  @IsEnum(NotificationType, { each: true })
  mutedTypes: NotificationType[];

  /**
   * Optional, unlike the list above, because a replacement that leaves it out has an obvious
   * meaning - the default - and a client built before the setting existed sends exactly that.
   * A value that is present is checked, for the same reason a retired type is: a client that
   * spells the setting wrong should be told, not humoured.
   */
  @ApiPropertyOptional({ enum: REVIEW_REQUEST_RESOLUTIONS })
  @IsOptional()
  @IsIn(REVIEW_REQUEST_RESOLUTIONS)
  reviewRequestResolution?: ReviewRequestResolution;
}
