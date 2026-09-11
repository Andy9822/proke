import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InboxSectionKey } from '../core/entities/inbox.interface';

export class InboxAuthorResponse {
  @ApiProperty()
  login: string;

  @ApiPropertyOptional()
  avatarUrl?: string;
}

export class InboxPullRequestResponse {
  @ApiProperty({ description: "GitHub's node id. Survives a repository or author rename." })
  id: string;

  @ApiProperty()
  number: number;

  @ApiProperty()
  title: string;

  @ApiProperty({ description: 'The html_url. Where a row links to.' })
  url: string;

  @ApiProperty()
  isDraft: boolean;

  @ApiProperty({ description: 'ISO 8601. When the pull request was opened, not when it moved.' })
  createdAt: string;

  @ApiProperty({ description: 'How many files it touches.' })
  changedFiles: number;

  @ApiProperty({ description: "GitHub's numeric repository id, as a string" })
  repositoryId: string;

  @ApiProperty({ description: 'owner/name' })
  repositoryFullName: string;

  @ApiProperty({ type: InboxAuthorResponse })
  author: InboxAuthorResponse;
}

export class InboxTeamResponse {
  @ApiProperty({ description: '`org/slug`, lowercased. What `excludedTeams` names.' })
  key: string;

  @ApiProperty()
  org: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ description: "GitHub's display name for the team, which is not its slug." })
  name: string;
}

export class InboxSectionResponse {
  @ApiProperty({
    enum: InboxSectionKey,
    description: 'The client owns the heading; the server owns which pile a row is in.',
  })
  key: InboxSectionKey;

  @ApiProperty({
    type: InboxPullRequestResponse,
    isArray: true,
    description: 'Server-ordered. Render in the order given.',
  })
  pullRequests: InboxPullRequestResponse[];
}

/**
 * One person's inbox as of one moment, plus enough about that moment for the client to be
 * honest about what it is showing.
 *
 * Every section is present even when empty, so finishing the last thing in a pile does not make
 * its heading disappear and reshuffle the page underneath the reader.
 */
export class InboxResponse {
  @ApiPropertyOptional({
    description:
      'When GitHub last answered, ISO 8601. Absent only when it never has for this user.',
  })
  refreshedAt?: string;

  @ApiProperty({
    description:
      'True when this is an older snapshot served because the refresh behind it failed. The ' +
      'rows are real, they are just not current.',
  })
  stale: boolean;

  @ApiProperty({
    description:
      'The stored GitHub authorization is gone or was revoked. Nothing can be refreshed until ' +
      'the user reconnects. Deliberately not a 401 - the proke session is perfectly good.',
  })
  githubReauthRequired: boolean;

  @ApiPropertyOptional({
    type: InboxTeamResponse,
    isArray: true,
    description:
      'The teams the "your team" grouping is built from, so the settings can list them. Absent ' +
      'means not established - GitHub has not been asked yet, or would not say, which is a ' +
      'missing "Members: Read" permission as often as an outage. An empty array means you are ' +
      'in none, which is a different instruction to whoever is reading it.',
  })
  teams?: InboxTeamResponse[];

  @ApiProperty({ type: InboxSectionResponse, isArray: true })
  yours: InboxSectionResponse[];

  @ApiProperty({ type: InboxSectionResponse, isArray: true })
  waitingOnYou: InboxSectionResponse[];
}
