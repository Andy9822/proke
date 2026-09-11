import axios from "axios";
import type { NotificationType } from "./connections.api";
import type { InboxFilters } from "./inbox.api";

/**
 * Which kinds of poke somebody has switched off, everywhere.
 *
 * The noes rather than the yeses, and that way round on purpose: a list of what somebody wants
 * would freeze today's idea of "everything" the first time they touched a switch, so a kind
 * added later would arrive muted for everyone who was already here. Stored like this, an
 * untouched account is on for everything and a new kind is on for everybody.
 */
export interface PokeSettings {
  mutedTypes: NotificationType[];
  /**
   * When a review request poke is struck through once somebody else reviews. `any_review` is
   * the first verdict from anybody; `strict` waits until GitHub no longer lists you - or the
   * team the request came through - as a requested reviewer. Mirrors the backend's
   * ReviewRequestResolution, and the two are meant to be kept level.
   */
  reviewRequestResolution: ReviewRequestResolution;
  digestEnabled: boolean;
  /** Nought to twenty-three, read in this browser's timezone. */
  digestHour: number;
}

export type ReviewRequestResolution = "any_review" | "strict";

/**
 * Nothing muted, struck through at the first review, no digest. What an untouched account means.
 *
 * The digest is the one thing off rather than on: nobody is given a new daily message for having
 * signed up.
 */
export const DEFAULT_POKE_SETTINGS: PokeSettings = {
  mutedTypes: [],
  reviewRequestResolution: "any_review",
  digestEnabled: false,
  digestHour: 9,
};

export interface User {
  id: string;
  githubId?: string;
  githubLogin?: string;
  email?: string;
  authMethod?: string;
  avatarUrl?: string;
  /**
   * How this person has the inbox set, complete - the server fills in the defaults for anything
   * they have never touched. Carried on the profile rather than fetched by the inbox, because
   * the profile is read before any page under `/app` renders, so the inbox opens on the right
   * settings without a request of its own in front of its first paint.
   */
  inboxSettings: InboxFilters;
  /**
   * Which kinds of poke they have switched off, complete. Here for the same reason as the inbox
   * settings, and it shows more: the dashboard's list is nine switches, and reading them off the
   * profile is what keeps it from drawing every one of them on for a frame first.
   */
  pokeSettings: PokeSettings;
}

export class UserApi {
  public static async getMe(jwtToken: string): Promise<User> {
    const response = await axios.get<User>("/users/me", {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
      },
    });

    return response.data;
  }
}

export class PokeSettingsApi {
  /**
   * Replaces the whole set. Unmuting is spelled by sending it without that type in it, so there
   * is nothing to patch - and the answer is what is now stored, so the panel draws the truth
   * rather than its own request.
   */
  public static async update(
    jwtToken: string,
    settings: PokeSettings
  ): Promise<PokeSettings> {
    // The zone rides along on every save: only the browser knows it, and moving changes it.
    const response = await axios.put<PokeSettings>(
      "/notifications/settings",
      { ...settings, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      { headers: { Authorization: `Bearer ${jwtToken}` } }
    );

    return response.data;
  }
}
