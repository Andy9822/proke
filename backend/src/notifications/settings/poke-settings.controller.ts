import { Body, Controller, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AnalyticsService } from '../../analytics/analytics.service';
import { CurrentUserId } from '../../auth/core/decorators/current-user-id.decorator';
import { UserWriteService } from '../../user/write/user-write.service';
import { DEFAULT_POKE_SETTINGS } from '../core/poke-settings';
import { PokeSettingsResponse } from '../dto/poke-settings.response';
import { UpdatePokeSettingsBody } from '../dto/update-poke-settings.body';

/**
 * What pokes somebody, across every organisation they listen to.
 *
 * There is no GET. The settings arrive on the profile, which the client reads before it renders
 * anything under `/app`, so a route of their own would be a second request for something already
 * in hand - and a frame of the dashboard drawn on the defaults while it was in flight. The same
 * arrangement the inbox settings use, for the same reason.
 */
@Controller('notifications/settings')
@ApiTags('Notifications')
@ApiBearerAuth()
export class PokeSettingsController {
  constructor(
    private readonly userWriteService: UserWriteService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Replaces what somebody has set about pokes.
   *
   * A PUT because it is the whole set every time: unmuting is spelled by sending the set without
   * that type in it, and a merge would make it unspellable. A body without the review request
   * setting means the default, which is the same thing the row means without it. Answers with
   * what is now stored, normalised, so the client draws the truth rather than its own request.
   */
  @Put()
  @ApiResponse({ type: PokeSettingsResponse })
  public async updateSettings(
    @CurrentUserId() userId: string,
    @Body() body: UpdatePokeSettingsBody,
  ): Promise<PokeSettingsResponse> {
    const settings = await this.userWriteService.updatePokeSettings(
      userId,
      {
        mutedTypes: body.mutedTypes,
        reviewRequestResolution:
          body.reviewRequestResolution ?? DEFAULT_POKE_SETTINGS.reviewRequestResolution,
        // Absences passed through: a client that has not heard of the digest cannot reset it.
        digestEnabled: body.digestEnabled,
        digestHour: body.digestHour,
      },
      body.timezone,
    );

    // The names go in whole, unlike the inbox's team and author lists: these are our own closed
    // set rather than somebody else's data, and which kinds people actually switch off is the
    // one question worth asking of this panel. The count rides along so the common answer -
    // nobody has muted anything - is one number rather than an empty array to interpret.
    this.analytics.capture(userId, 'poke_settings_updated', {
      muted_types: settings.mutedTypes,
      muted_count: settings.mutedTypes.length,
      review_request_resolution: settings.reviewRequestResolution,
      digest_enabled: settings.digestEnabled,
      digest_hour: settings.digestHour,
    });

    return settings;
  }
}
