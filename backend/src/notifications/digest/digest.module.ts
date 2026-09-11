import { Module } from '@nestjs/common';
import { InboxModule } from '../../inbox/inbox.module';
import { UserReadModule } from '../../user/read/user-read.module';
import { UserWriteModule } from '../../user/write/user-write.module';
import { NotificationsCoreModule } from '../core/notifications-core.module';
import { DigestService } from './digest.service';

/**
 * The timer that sends the daily digest.
 *
 * Above the modules it uses, like InboxWarmModule: neither the inbox that builds the list nor
 * the delivery that sends it should know about a schedule.
 */
@Module({
  imports: [InboxModule, UserReadModule, UserWriteModule, NotificationsCoreModule],
  providers: [DigestService],
  exports: [DigestService],
})
export class DigestModule {}
