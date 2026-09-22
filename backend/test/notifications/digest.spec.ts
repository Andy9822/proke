import * as nock from 'nock';
import * as request from 'supertest';
import { NotificationType } from '../../src/notifications/core/entities/notification-type.enum';
import { DEFAULT_POKE_SETTINGS } from '../../src/notifications/core/poke-settings';
import { createTestApp } from '../utils/bootstrap';

const TEAM_ID = 'T0ACME';

/**
 * The daily digest: who it is sent to, when, and what it says.
 *
 * 2026-09-11T08:30:00Z is 09:30 in Lisbon, 01:30 in Los Angeles and 17:30 in Tokyo, so a user
 * whose hour is nine is due in two of those three and not the third.
 */
describe('The daily digest', () => {
  let bootstrap: Awaited<ReturnType<typeof createTestApp>>;

  const MORNING_IN_LISBON = new Date('2026-09-11T08:30:00Z');
  const AFTERNOON_IN_LISBON = new Date('2026-09-11T13:30:00Z');
  const NEXT_MORNING_IN_LISBON = new Date('2026-09-12T08:30:00Z');

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = 'test-encryption-key';

    bootstrap = await createTestApp();
  });

  beforeEach(async () => {
    await bootstrap.methods.beforeEach();
  });

  afterAll(async () => {
    await bootstrap.methods.afterAll();
  });

  const server = () => bootstrap.app.getHttpServer();
  const digest = () => bootstrap.services.digestService;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const pullRequest = (overrides: Record<string, any> = {}) => ({
    id: `node-${Math.random()}`,
    number: 1,
    title: 'A change',
    url: 'https://github.com/acme/api/pull/1',
    isDraft: false,
    updatedAt: '2026-09-11T00:00:00Z',
    createdAt: '2026-09-08T08:30:00Z',
    changedFiles: 4,
    repository: { id: 'repo-1', nameWithOwner: 'acme/api' },
    author: { __typename: 'User', login: 'bob', avatarUrl: 'https://avatars/bob' },
    reviewThreads: { nodes: [] },
    ...overrides,
  });

  /** One GraphQL answer and one teams answer: exactly what building one inbox costs. */
  const mockOneRefresh = (waitingOnYou: any[] = [pullRequest()]) => {
    nock('https://api.github.com')
      .post('/graphql')
      .reply(200, {
        data: {
          viewer: { login: 'ada' },
          yours: { nodes: [] },
          waitingOnYou: { nodes: waitingOnYou },
        },
      });
    nock('https://api.github.com').get('/user/teams').query(true).reply(200, []);
  };

  /** Registered even where nothing should be sent, so an accidental post fails an assertion. */
  const capturePost = () => {
    const posts: any[] = [];

    nock('https://slack.com')
      .post('/api/chat.postMessage', (body) => {
        posts.push(body);
        return true;
      })
      .times(10)
      .reply(200, { ok: true });

    return posts;
  };

  /** Counting posts alone cannot tell a skipped sweep from one GitHub refused. */
  const untouchedGithubMocks = () =>
    nock.pendingMocks().some((mock) => mock.includes('api.github.com'));

  /**
   * Somebody connected end to end, with the digest already on. Written onto the row rather than
   * through the settings route, because enabling it there deliberately uses up the current day.
   */
  const digestUser = async (
    options: {
      timezone?: string;
      hour?: number;
      enabled?: boolean;
      githubAccessToken?: string | undefined;
      slack?: boolean;
      sentOn?: string;
    } = {},
  ) => {
    const { user, token } = await bootstrap.utils.authUtils.setupUser({
      githubLogin: 'ada',
      githubAccessToken: 'githubAccessToken' in options ? options.githubAccessToken : 'gho_token',
    });

    await bootstrap.models.userModel.updateOne(
      { _id: user.id },
      {
        $set: {
          timezone: options.timezone ?? 'Europe/Lisbon',
          pokeSettings: {
            mutedTypes: [],
            digestEnabled: options.enabled ?? true,
            digestHour: options.hour ?? 9,
          },
          ...(options.sentOn ? { digestSentOn: options.sentOn } : {}),
        },
      },
    );

    if (options.slack !== false) {
      await connectSlack(user.id);
    }

    return { user, token };
  };

  const connectSlack = async (userId: string) => {
    await bootstrap.models.slackWorkspaceModel.create({
      teamId: `${TEAM_ID}-${userId}`,
      teamName: 'Acme',
      botUserId: 'B0PROKE',
      botToken: 'xoxb-workspace-token',
    });
    await bootstrap.models.slackLinkModel.create({
      userId,
      teamId: `${TEAM_ID}-${userId}`,
      slackUserId: 'U0ADA',
      dmChannelId: 'D0ADA',
    });
  };

  /** Not the route: whether this spends today depends on the instant, so the spec holds it. */
  const enableDigest = (userId: string, hour: number, now: Date) =>
    bootstrap.services.userWriteService.updatePokeSettings(
      userId,
      {
        mutedTypes: [],
        reviewRequestResolution: 'any_review',
        digestEnabled: true,
        digestHour: hour,
      },
      'Europe/Lisbon',
      now,
    );

  const storedUser = async (userId: string) => bootstrap.models.userModel.findById(userId).lean();

  describe('who it goes to', () => {
    it('sends to somebody whose hour has come', async () => {
      await digestUser();
      mockOneRefresh();
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(1);
      expect(posts[0].channel).toEqual('D0ADA');
    });

    // The same instant is 09:30 in Lisbon and 01:30 in Los Angeles.
    it('leaves alone somebody for whom it is not yet that hour', async () => {
      await digestUser({ timezone: 'America/Los_Angeles' });
      mockOneRefresh();
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
      expect(untouchedGithubMocks()).toBe(true);
    });

    it('leaves alone somebody who has not asked for one', async () => {
      await digestUser({ enabled: false });
      mockOneRefresh();
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
      expect(untouchedGithubMocks()).toBe(true);
    });

    // The rule is whether their hour has been, not whether it is now, so a deploy across it
    // costs minutes rather than the day.
    it('still sends to somebody whose hour went by earlier in their day', async () => {
      await digestUser({ timezone: 'Asia/Tokyo' });
      mockOneRefresh();
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(1);
    });

    it('leaves alone somebody whose GitHub authorization is gone', async () => {
      await digestUser({ githubAccessToken: undefined });
      mockOneRefresh();
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
      expect(untouchedGithubMocks()).toBe(true);
    });

    it('survives somebody who has never connected Slack', async () => {
      await digestUser({ slack: false });
      mockOneRefresh();

      await expect(digest().sweep(MORNING_IN_LISBON)).resolves.toBeUndefined();
    });

    // Asserts the second person's message, not only that nothing threw: carrying on is the point.
    it('carries on past somebody whose inbox fails to build', async () => {
      await digestUser();
      await digestUser();

      nock('https://api.github.com').post('/graphql').reply(500, {});
      mockOneRefresh();
      const posts = capturePost();

      await expect(digest().sweep(MORNING_IN_LISBON)).resolves.toBeUndefined();

      expect(posts).toHaveLength(1);
    });

    // ignoredAuthors is applied when the inbox is served, so a digest reading the stored rows
    // straight off the snapshot would list them anyway.
    it('leaves out the authors their inbox is set to ignore', async () => {
      const { token } = await digestUser();

      await request(server())
        .put('/inbox/settings')
        .send({ ignoredAuthors: ['dependabot'] })
        .set(auth(token))
        .expect(200);

      mockOneRefresh([
        pullRequest({
          number: 1,
          title: 'Bump lodash',
          author: { __typename: 'Bot', login: 'dependabot', avatarUrl: 'https://avatars/dep' },
        }),
        pullRequest({ number: 2, title: 'A real change' }),
      ]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(1);
      expect(posts[0].text).toEqual('#2 A real change is waiting on your review.');
      expect(JSON.stringify(posts[0].blocks)).not.toContain('Bump lodash');
    });

    it('says nothing at all when nothing is waiting', async () => {
      await digestUser();
      mockOneRefresh([]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
    });
  });

  describe('the once-a-day claim', () => {
    it('sends one message however many times the sweep runs', async () => {
      const { user } = await digestUser();
      mockOneRefresh();
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);
      await digest().sweep(MORNING_IN_LISBON);
      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(1);
      expect((await storedUser(user.id))?.digestSentOn).toEqual('2026-09-11');
    });

    // Otherwise a quiet day costs an inbox rebuild on every pass until midnight.
    it('spends the day even when there was nothing to send', async () => {
      const { user } = await digestUser();
      mockOneRefresh([]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);
      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
      expect((await storedUser(user.id))?.digestSentOn).toEqual('2026-09-11');
    });

    it('tries again later in the day when GitHub could not be reached', async () => {
      const { user } = await digestUser();
      nock('https://api.github.com').post('/graphql').reply(502, {});
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
      expect((await storedUser(user.id))?.digestSentOn).toBeUndefined();

      mockOneRefresh();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(1);
    });

    it('sends again the next day', async () => {
      const { user } = await digestUser();
      mockOneRefresh();
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      mockOneRefresh();
      await digest().sweep(NEXT_MORNING_IN_LISBON);

      expect(posts).toHaveLength(2);
      expect((await storedUser(user.id))?.digestSentOn).toEqual('2026-09-12');
    });
  });

  describe('what it says', () => {
    const lines = (posts: any[]) =>
      posts[0].blocks
        .filter((block: any) => block.type === 'section')
        .map((block: any) => block.text.text);

    it('leads with the count and lists the oldest first', async () => {
      await digestUser();
      mockOneRefresh([
        pullRequest({ number: 2, title: 'Newer', createdAt: '2026-09-11T04:30:00Z' }),
        pullRequest({ number: 1, title: 'Older', createdAt: '2026-09-08T08:30:00Z' }),
      ]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const [heading, list] = lines(posts);

      expect(heading).toEqual('*2 pull requests are waiting on your review.*');
      expect(list.indexOf('Older')).toBeLessThan(list.indexOf('Newer'));
    });

    it('ages each row from when the pull request was opened', async () => {
      await digestUser();
      mockOneRefresh([
        pullRequest({ number: 1, createdAt: '2026-09-08T08:30:00Z' }),
        pullRequest({ number: 2, createdAt: '2026-09-11T04:30:00Z' }),
        pullRequest({ number: 3, createdAt: '2026-09-11T08:00:00Z' }),
      ]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const [, list] = lines(posts);

      expect(list).toContain('3 days old');
      expect(list).toContain('4 hours old');
      expect(list).toContain('just opened');
    });

    it('carries the size, the repository and the author of each row', async () => {
      await digestUser();
      mockOneRefresh([pullRequest({ number: 7, title: 'Retry the paginator', changedFiles: 1 })]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const [, list] = lines(posts);

      expect(list).toContain('#7 Retry the paginator');
      expect(list).toContain('1 file');
      expect(list).toContain('`acme/api`');
      expect(list).toContain('<https://github.com/bob|@bob>');
    });

    it('references no images at all', async () => {
      await digestUser();
      mockOneRefresh([pullRequest(), pullRequest({ number: 2 })]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(JSON.stringify(posts[0].blocks)).not.toContain('avatars');
      expect(posts[0].blocks.some((block: any) => block.type === 'image')).toBe(false);
    });

    it('stops listing past twenty and says how many more there were', async () => {
      await digestUser();
      mockOneRefresh(
        Array.from({ length: 23 }, (_unused, index) => pullRequest({ number: index + 1 })),
      );
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const context = posts[0].blocks.find((block: any) => block.type === 'context');

      expect(lines(posts).join('\n')).toContain('*23 pull requests are waiting on your review.*');
      expect(context.elements[0].text).toEqual('and 3 more waiting on you.');
    });

    it('carries the whole point in the notification preview', async () => {
      await digestUser();
      mockOneRefresh([pullRequest({ number: 7, title: 'Retry the paginator' })]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts[0].text).toEqual('#7 Retry the paginator is waiting on your review.');
    });

    // Twenty rows of a real repository run to ~4,400 characters, so splitting is the normal path.
    it('splits a long list into sections Slack will accept', async () => {
      await digestUser();
      mockOneRefresh(
        Array.from({ length: 20 }, (_unused, index) =>
          pullRequest({
            number: index + 1,
            title: 'Retry the paginator when the upstream cursor expires mid-page',
            url: `https://github.com/acme/platform-services/pull/${index + 1}`,
            repository: { id: 'repo-1', nameWithOwner: 'acme/platform-services' },
          }),
        ),
      );
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const [heading, ...chunks] = lines(posts);

      expect(heading).toEqual('*20 pull requests are waiting on your review.*');
      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThan(3000);
      }

      // None of them fell down the gap between two sections.
      for (let number = 1; number <= 20; number += 1) {
        expect(chunks.join('\n')).toContain(`#${number} Retry`);
      }
    });

    it('cuts a title too long to sit on one row', async () => {
      await digestUser();
      mockOneRefresh([
        pullRequest({
          number: 7,
          title:
            'Rework the reconciliation job so a partial page never leaves the cursor behind, ' +
            'and backfill the ones it already did',
        }),
      ]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const [, list] = lines(posts);

      expect(list).toContain('Rework the reconciliation job so a partial page');
      expect(list).toContain('…');
      expect(list).not.toContain('backfill');
    });

    it('escapes the markup a title may carry, and only once', async () => {
      await digestUser();
      mockOneRefresh([pullRequest({ number: 7, title: 'Fix <T> & <U> parsing' })]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const [, list] = lines(posts);

      expect(list).toContain('#7 Fix &lt;T&gt; &amp; &lt;U&gt; parsing');
      expect(list).not.toContain('&amp;lt;');
    });

    it('keeps the order when one row has no readable opening time', async () => {
      await digestUser();
      // `updatedAt` sets the arrival order, and this one is where NaN takes the rest with it.
      mockOneRefresh([
        pullRequest({
          number: 1,
          title: 'Newer',
          createdAt: '2026-09-11T04:30:00Z',
          updatedAt: '2026-09-11T04:00:00Z',
        }),
        pullRequest({
          number: 2,
          title: 'Undated',
          createdAt: null,
          updatedAt: '2026-09-11T03:00:00Z',
        }),
        pullRequest({
          number: 3,
          title: 'Older',
          createdAt: '2026-09-05T08:30:00Z',
          updatedAt: '2026-09-11T02:00:00Z',
        }),
        pullRequest({
          number: 4,
          title: 'Middling',
          createdAt: '2026-09-08T08:30:00Z',
          updatedAt: '2026-09-11T01:00:00Z',
        }),
      ]);
      const posts = capturePost();

      await digest().sweep(MORNING_IN_LISBON);

      const [, list] = lines(posts);

      expect(list.indexOf('Older')).toBeLessThan(list.indexOf('Middling'));
      expect(list.indexOf('Middling')).toBeLessThan(list.indexOf('Newer'));
      expect(list).toContain('age unknown');
    });
  });

  describe('the settings', () => {
    it('is off, at nine, for somebody who has never touched it', async () => {
      const { token } = await bootstrap.utils.authUtils.setupUser();

      const { body } = await request(server()).get('/users/me').set(auth(token)).expect(200);

      expect(body.pokeSettings.digestEnabled).toBe(DEFAULT_POKE_SETTINGS.digestEnabled);
      expect(body.pokeSettings.digestHour).toBe(DEFAULT_POKE_SETTINGS.digestHour);
    });

    it('stores the hour and the zone, and hands them back with the user', async () => {
      const { token, user } = await bootstrap.utils.authUtils.setupUser();

      const updated = await request(server())
        .put('/notifications/settings')
        .send({ mutedTypes: [], digestEnabled: true, digestHour: 7, timezone: 'Europe/Lisbon' })
        .set(auth(token))
        .expect(200);

      expect(updated.body.digestEnabled).toBe(true);
      expect(updated.body.digestHour).toBe(7);

      const me = await request(server()).get('/users/me').set(auth(token)).expect(200);

      expect(me.body.pokeSettings.digestHour).toBe(7);
      expect((await storedUser(user.id))?.timezone).toEqual('Europe/Lisbon');
    });

    it('rejects an hour and a zone it cannot read rather than storing a default', async () => {
      const { token } = await bootstrap.utils.authUtils.setupUser();

      await request(server())
        .put('/notifications/settings')
        .send({ mutedTypes: [], digestHour: 24 })
        .set(auth(token))
        .expect(400);

      await request(server())
        .put('/notifications/settings')
        .send({ mutedTypes: [], timezone: 'Middle/Earth' })
        .set(auth(token))
        .expect(400);
    });

    it('starts tomorrow when it is switched on after the hour has been', async () => {
      const { user } = await bootstrap.utils.authUtils.setupUser({
        githubAccessToken: 'gho_token',
      });
      await connectSlack(user.id);
      mockOneRefresh();
      const posts = capturePost();

      await enableDigest(user.id, 9, MORNING_IN_LISBON);

      expect((await storedUser(user.id))?.digestSentOn).toEqual('2026-09-11');

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
      expect(untouchedGithubMocks()).toBe(true);
    });

    it('starts today when it is switched on before the hour has been', async () => {
      const { user } = await bootstrap.utils.authUtils.setupUser({
        githubAccessToken: 'gho_token',
      });
      await connectSlack(user.id);
      mockOneRefresh();
      const posts = capturePost();

      await enableDigest(user.id, 14, MORNING_IN_LISBON);

      expect((await storedUser(user.id))?.digestSentOn).toBeUndefined();

      await digest().sweep(AFTERNOON_IN_LISBON);

      expect(posts).toHaveLength(1);
    });

    it('still sends today when an unrelated save lands after the hour, before the sweep', async () => {
      const { user } = await bootstrap.utils.authUtils.setupUser({
        githubAccessToken: 'gho_token',
      });
      await connectSlack(user.id);
      mockOneRefresh();
      const posts = capturePost();

      // Switched on at half past seven, so today is not spent.
      await enableDigest(user.id, 9, new Date('2026-09-11T06:30:00Z'));

      // A mute at half past nine: the hour has been, no sweep has run yet.
      await bootstrap.services.userWriteService.updatePokeSettings(
        user.id,
        { mutedTypes: [NotificationType.IssueComment], reviewRequestResolution: 'any_review' },
        'Europe/Lisbon',
        MORNING_IN_LISBON,
      );

      expect((await storedUser(user.id))?.digestSentOn).toBeUndefined();

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(1);
    });

    it('starts tomorrow when the zone arrives after the hour has been', async () => {
      const { user } = await bootstrap.utils.authUtils.setupUser({
        githubAccessToken: 'gho_token',
      });
      await connectSlack(user.id);
      mockOneRefresh();
      const posts = capturePost();

      // Switched on from a client that sent no zone: nothing to claim against yet.
      await bootstrap.services.userWriteService.updatePokeSettings(
        user.id,
        {
          mutedTypes: [],
          reviewRequestResolution: 'any_review',
          digestEnabled: true,
          digestHour: 9,
        },
        undefined,
        new Date('2026-09-11T06:30:00Z'),
      );

      expect((await storedUser(user.id))?.digestSentOn).toBeUndefined();

      // The zone lands at half past nine. Minutes later is not the hour they chose.
      await bootstrap.services.userWriteService.updatePokeSettings(
        user.id,
        { mutedTypes: [], reviewRequestResolution: 'any_review' },
        'Europe/Lisbon',
        MORNING_IN_LISBON,
      );

      expect((await storedUser(user.id))?.digestSentOn).toEqual('2026-09-11');

      await digest().sweep(MORNING_IN_LISBON);

      expect(posts).toHaveLength(0);
      expect(untouchedGithubMocks()).toBe(true);
    });

    it('leaves an existing schedule alone when a client saves without it', async () => {
      const { token, user } = await bootstrap.utils.authUtils.setupUser();

      await request(server())
        .put('/notifications/settings')
        .send({ mutedTypes: [], digestEnabled: true, digestHour: 7, timezone: 'Europe/Lisbon' })
        .set(auth(token))
        .expect(200);

      // A tab that predates the feature: the whole set, as it knows it.
      await request(server())
        .put('/notifications/settings')
        .send({ mutedTypes: [] })
        .set(auth(token))
        .expect(200);

      expect((await storedUser(user.id))?.timezone).toEqual('Europe/Lisbon');
      expect((await storedUser(user.id))?.pokeSettings?.digestHour).toBe(7);
    });
  });
});
