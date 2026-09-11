import { actions, connect, kea, listeners, path, reducers, selectors } from "kea";
import { loaders } from "kea-loaders";

import type { NotificationType } from "../api/connections.api";
import {
  DEFAULT_POKE_SETTINGS,
  PokeSettingsApi,
  type PokeSettings,
  type ReviewRequestResolution,
} from "../api/user.api";
import { authLogic } from "./authLogic";

import type { pokeSettingsLogicType } from './pokeSettingsLogicType'

/**
 * Which kinds of poke reach this account at all, and the one way they change.
 *
 * Deliberately the same shape as inboxSettingsLogic, because it is the same problem: settings
 * that live on the account, arrive on the profile, and are moved one switch at a time.
 *
 * ## Where the settings come from
 *
 * The profile - `authLogic` reads it before anything under `/app` renders - so nothing here
 * loads anything and the panel's first frame is already the truth rather than nine switches
 * drawn on and corrected a moment later. What this logic holds is the edits made since.
 *
 * ## Why the writes are optimistic
 *
 * Because every setting is a switch, and a switch that waits for a round trip before moving is a
 * switch people press twice. The edit lands on screen at the press; the server's answer replaces
 * it a moment later, and on the rare failure the edit is dropped, the panel goes back to what
 * the server last agreed to, and a line says so.
 *
 * ## Why the whole set is sent
 *
 * Because unmuting is spelled by sending the set *without* that type in it - there is no other
 * way to say it - so a partial update could not express half of what this panel does. Two
 * presses in quick succession each send the set as it stood at that press, and the breakpoint
 * drops the earlier answer if a later save has started, so the last thing on screen is the last
 * thing saved.
 */
export const pokeSettingsLogic = kea<pokeSettingsLogicType>([
  path(["src", "lib", "logics", "pokeSettingsLogic"]),

  connect(() => ({
    values: [authLogic, ["userData"]],
    actions: [authLogic, ["logout"]],
  })),

  actions({
    /** Flip one kind. Takes effect now; the save follows. */
    toggleType: (type: NotificationType) => ({ type }),
    /** Choose when a review request is struck through. Same timing as a flip. */
    setReviewRequestResolution: (resolution: ReviewRequestResolution) => ({
      resolution,
    }),
    /** Turn the daily digest on or off. Same timing as a flip. */
    setDigestEnabled: (enabled: boolean) => ({ enabled }),
    /** Choose the hour it arrives, in this browser's timezone. */
    setDigestHour: (hour: number) => ({ hour }),
    /** The whole set as it now stands on screen, ahead of the server agreeing. */
    edit: (settings: PokeSettings) => ({ settings }),
    dismissNotice: true,
  }),

  loaders(({ values }) => ({
    /** What the server last answered with, or nothing until it has answered once this session. */
    savedByServer: [
      null as PokeSettings | null,
      {
        saveSettings: async (
          { settings }: { settings: PokeSettings },
          breakpoint
        ): Promise<PokeSettings | null> => {
          const jwtToken = authLogic.values.jwtToken;

          if (!jwtToken) {
            return values.savedByServer;
          }

          const saved = await PokeSettingsApi.update(jwtToken, settings);
          // Drops this answer if a newer save started while it was in flight, so a slow one
          // cannot land on top of a fast one that came after it.
          breakpoint();

          return saved;
        },
      },
    ],
  })),

  reducers({
    savedByServer: [
      null as PokeSettings | null,
      {
        // Or the next person to sign in on this browser sees this one's switches for the moment
        // before their own profile arrives.
        logout: () => null,
      },
    ],
    /**
     * The set on screen while a save is in flight, or nothing when the screen agrees with the
     * server. Cleared by the answer either way: on success the answer is what to show, on
     * failure the last agreed set is, which is what reverting means here.
     */
    edited: [
      null as PokeSettings | null,
      {
        edit: (_, { settings }) => settings,
        saveSettingsSuccess: () => null,
        saveSettingsFailure: () => null,
        logout: () => null,
      },
    ],
    /**
     * A save the server refused, in words, or nothing. Cleared by whatever happens next: a
     * refusal is about the press that caused it and stops being true at the next one.
     */
    notice: [
      null as string | null,
      {
        saveSettingsFailure: () =>
          "Couldn't save that, so it's back to how it was.",
        toggleType: () => null,
        setReviewRequestResolution: () => null,
        setDigestEnabled: () => null,
        setDigestHour: () => null,
        dismissNotice: () => null,
      },
    ],
  }),

  selectors({
    /**
     * What the server has agreed to, from wherever it last said so.
     *
     * A selector rather than a reducer seeded at mount, because the profile may have been read
     * before this logic mounted or after it, and a selector is right in both orders without
     * either having to know about the other.
     */
    saved: [
      (s) => [s.savedByServer, s.userData],
      (
        savedByServer: PokeSettings | null,
        userData: { pokeSettings?: PokeSettings } | null
      ): PokeSettings | null =>
        savedByServer ?? userData?.pokeSettings ?? null,
    ],
    /** The set the panel draws. Complete, never partial. */
    settings: [
      (s) => [s.edited, s.saved],
      (edited: PokeSettings | null, saved: PokeSettings | null): PokeSettings =>
        edited ?? saved ?? DEFAULT_POKE_SETTINGS,
    ],
    /**
     * Whether the account has been read. Until it has, the panel is drawing the defaults - which
     * are also what most accounts turn out to hold, so it says nothing about it beyond not
     * animating a count that is about to change.
     */
    loaded: [(s) => [s.saved], (saved: PokeSettings | null): boolean => saved !== null],
    mutedTypes: [
      (s) => [s.settings],
      (settings: PokeSettings): NotificationType[] => settings.mutedTypes,
    ],
    reviewRequestResolution: [
      (s) => [s.settings],
      (settings: PokeSettings): ReviewRequestResolution =>
        settings.reviewRequestResolution,
    ],
    digestEnabled: [
      (s) => [s.settings],
      (settings: PokeSettings): boolean => settings.digestEnabled,
    ],
    digestHour: [
      (s) => [s.settings],
      (settings: PokeSettings): number => settings.digestHour,
    ],
  }),

  listeners(({ actions, values }) => ({
    // Both build on the whole set as it stands rather than on the one field they move: the
    // save replaces everything, so a set built from one field would quietly put the other back
    // to its default on every press.
    toggleType: ({ type }) => {
      const muted = values.mutedTypes.includes(type);
      const next: PokeSettings = {
        ...values.settings,
        mutedTypes: muted
          ? values.mutedTypes.filter((existing) => existing !== type)
          : [...values.mutedTypes, type],
      };

      // On screen now, on the account a moment later. See the note above on why that order.
      actions.edit(next);
      actions.saveSettings({ settings: next });
    },
    setReviewRequestResolution: ({ resolution }) => {
      const next: PokeSettings = {
        ...values.settings,
        reviewRequestResolution: resolution,
      };

      actions.edit(next);
      actions.saveSettings({ settings: next });
    },
    setDigestEnabled: ({ enabled }) => {
      const next: PokeSettings = { ...values.settings, digestEnabled: enabled };

      actions.edit(next);
      actions.saveSettings({ settings: next });
    },
    setDigestHour: ({ hour }) => {
      const next: PokeSettings = { ...values.settings, digestHour: hour };

      actions.edit(next);
      actions.saveSettings({ settings: next });
    },
  })),
]);
