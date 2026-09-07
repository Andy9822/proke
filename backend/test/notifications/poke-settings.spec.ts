import * as request from 'supertest';
import {
  ALL_NOTIFICATION_TYPES,
  NotificationType,
} from '../../src/notifications/core/entities/notification-type.enum';
import { createTestApp } from '../utils/bootstrap';

/**
 * The account-wide half of what pokes somebody: which kinds they have switched off, everywhere.
 *
 * The delivery consequences live in the webhook spec, where there is an event to send. These are
 * about the settings themselves - what is stored, what comes back, and what an account that has
 * never touched them answers.
 */
describe('Poke settings', () => {
  let bootstrap: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    bootstrap = await createTestApp();
  });

  beforeEach(async () => {
    await bootstrap.methods.beforeEach();
  });

  afterAll(async () => {
    await bootstrap.methods.afterAll();
  });

  const update = (token: string, mutedTypes: unknown, reviewRequestResolution?: unknown) =>
    request(bootstrap.app.getHttpServer())
      .put('/notifications/settings')
      .set('authorization', `Bearer ${token}`)
      .send({
        mutedTypes,
        ...(reviewRequestResolution === undefined ? {} : { reviewRequestResolution }),
      });

  const readProfile = (token: string) =>
    request(bootstrap.app.getHttpServer()).get('/users/me').set('authorization', `Bearer ${token}`);

  it('says nothing is muted for an account that has never touched the settings', async () => {
    // given
    const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });

    // when
    const response = await readProfile(token);

    // then - the whole point of storing the noes: an untouched account is on for everything,
    // including kinds that did not exist when it was created. And struck through at the first
    // review, which is the default the same way.
    expect(response.status).toEqual(200);
    expect(response.body.pokeSettings).toEqual({
      mutedTypes: [],
      reviewRequestResolution: 'any_review',
    });
  });

  it('stores what was switched off and hands it back on the profile', async () => {
    // given
    const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });

    // when
    const saved = await update(token, [
      NotificationType.IssueComment,
      NotificationType.AutoMergeEnabled,
    ]);

    // then
    expect(saved.status).toEqual(200);
    expect(saved.body.mutedTypes.sort()).toEqual(
      [NotificationType.AutoMergeEnabled, NotificationType.IssueComment].sort(),
    );

    // and - the dashboard reads these off the profile rather than asking for them
    const profile = await readProfile(token);
    expect(profile.body.pokeSettings.mutedTypes.sort()).toEqual(saved.body.mutedTypes.sort());
  });

  it('unmutes by leaving the type out, rather than by any switch of its own', async () => {
    // given
    const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });
    await update(token, [NotificationType.IssueComment, NotificationType.IssueMention]);

    // when - the whole set every time, which is what makes the removal legible
    const response = await update(token, [NotificationType.IssueMention]);

    // then
    expect(response.body.mutedTypes).toEqual([NotificationType.IssueMention]);
  });

  it('drops a retired type rather than letting it mute anything', async () => {
    // given - a row written when team mentions were a kind of their own
    const { user, token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });
    await bootstrap.models.userModel.updateOne(
      { _id: user.id },
      { $set: { pokeSettings: { mutedTypes: ['team_mention', NotificationType.IssueComment] } } },
    );

    // when
    const response = await readProfile(token);

    // then - retiring a type costs no migration precisely because of this
    expect(response.body.pokeSettings.mutedTypes).toEqual([NotificationType.IssueComment]);
  });

  it('refuses a type it does not know', async () => {
    // given
    const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });

    // when
    const response = await update(token, ['team_mention']);

    // then - a 400 rather than a silent no-op, which is the more useful answer to a stale client
    expect(response.status).toEqual(400);
  });

  it('accepts every kind at once, which is how nothing at all is spelled', async () => {
    // given
    const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });

    // when
    const response = await update(token, ALL_NOTIFICATION_TYPES);

    // then
    expect(response.status).toEqual(200);
    expect(response.body.mutedTypes.sort()).toEqual([...ALL_NOTIFICATION_TYPES].sort());
  });

  it('needs a session', async () => {
    // when
    const response = await update('not-a-token', [NotificationType.IssueComment]);

    // then
    expect(response.status).toEqual(401);
  });

  /**
   * The one setting here that is not a switch off: when a review request poke is struck
   * through once somebody else reviews. What it does to the message is poke-resolution.spec.ts;
   * these are about the value itself.
   */
  describe('the review request setting', () => {
    it('stores it and hands it back on the profile', async () => {
      // given
      const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });

      // when
      const saved = await update(token, [], 'strict');

      // then
      expect(saved.status).toEqual(200);
      expect(saved.body.reviewRequestResolution).toEqual('strict');

      const profile = await readProfile(token);
      expect(profile.body.pokeSettings.reviewRequestResolution).toEqual('strict');
    });

    it('reads a body without it as the default', async () => {
      // given - a client from before the setting existed sends the muted kinds and nothing else
      const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });
      await update(token, [], 'strict');

      // when
      const response = await update(token, [NotificationType.IssueComment]);

      // then - the whole set every time, so leaving it out is putting it back
      expect(response.status).toEqual(200);
      expect(response.body).toEqual({
        mutedTypes: [NotificationType.IssueComment],
        reviewRequestResolution: 'any_review',
      });
    });

    it('keeps the muted kinds when only it changes', async () => {
      // given
      const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });

      // when
      const response = await update(token, [NotificationType.IssueMention], 'strict');

      // then
      expect(response.body).toEqual({
        mutedTypes: [NotificationType.IssueMention],
        reviewRequestResolution: 'strict',
      });
    });

    it('reads a stored value it does not know as the default', async () => {
      // given - a row written by a deploy with a third option this one has never heard of
      const { user, token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });
      await bootstrap.models.userModel.updateOne(
        { _id: user.id },
        { $set: { pokeSettings: { mutedTypes: [], reviewRequestResolution: 'lenient' } } },
      );

      // when
      const response = await readProfile(token);

      // then
      expect(response.body.pokeSettings.reviewRequestResolution).toEqual('any_review');
    });

    it('refuses a value it does not know', async () => {
      // given
      const { token } = await bootstrap.utils.authUtils.setupUser({ githubId: '4242' });

      // when
      const response = await update(token, [], 'lenient');

      // then
      expect(response.status).toEqual(400);
    });
  });
});
