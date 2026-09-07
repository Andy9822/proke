import {
  NOTIFICATION_TYPES,
  Octicon,
  POKE_GROUPS,
  type NotificationTypeDescriptor,
  type PokeGroup,
} from "@/components/notifications/notificationTypes";
import { PokeReel } from "@/components/notifications/PokeReel";
import type { NotificationType } from "@/lib/api/connections.api";
import type { ReviewRequestResolution } from "@/lib/api/user.api";
import { cn } from "@/lib/utils";
import { useState } from "react";

const CHECK =
  "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z";

export interface PokesPanelProps {
  /** The kinds switched off, account-wide. Empty is the common answer and the default. */
  mutedTypes: NotificationType[];
  onToggleType: (type: NotificationType) => void;
  /** When a review request is struck through once somebody else reviews. */
  reviewRequestResolution: ReviewRequestResolution;
  onSetReviewRequestResolution: (resolution: ReviewRequestResolution) => void;
  /** A refused save, in words. Optional so the drafts gallery renders the panel without one. */
  notice?: string | null;
}

/**
 * What a poke can be about, and the nine switches that decide which of them reach you.
 *
 * ## Account-wide, which is the whole point
 *
 * These are not per-organisation. Somebody who does not want to hear about merges does not want
 * to hear about them anywhere, and asking that question once per org would be asking it four
 * times for one answer. An organisation can still narrow further - that is what a subscription
 * is - but nothing can widen past what is set here.
 *
 * ## Why a flat list under headings rather than collapsible groups
 *
 * Because the window underneath is the point. Every row is a hover target that scrolls the reel
 * to the poke that row produces, so you can see what you are switching off before you switch it
 * off - and a group that folds away takes its rows, and that answer, with it. The headings are
 * dividers with a control on them, not sections that open.
 *
 * ## Why the switches move before the server answers
 *
 * Because a switch that waits for a round trip is a switch people press twice. The write is short
 * and nearly always succeeds; where it does not, the panel goes back to what was stored and says
 * so on the line under the list. See pokeSettingsLogic.
 *
 * ## The one row that is not a kind
 *
 * Under the review request sits a second switch about the same poke: whether it is struck
 * through at the first review from anybody, or kept until GitHub stops asking you. It is drawn
 * indented under its parent rather than as a tenth kind, because it is not one - it changes what
 * happens to a poke after it has arrived, not whether it arrives - and it is not counted in the
 * header for the same reason. It goes quiet when its parent is off: there is nothing to strike.
 */
export function PokesPanel({
  mutedTypes,
  onToggleType,
  reviewRequestResolution,
  onSetReviewRequestResolution,
  notice,
}: PokesPanelProps) {
  // The row the reel is showing. Follows the pointer, and stays where it was left afterwards -
  // the last thing looked at is the most useful thing to still be looking at.
  const [activeIndex, setActiveIndex] = useState(0);

  const on = NOTIFICATION_TYPES.length - mutedTypes.length;
  const everything = mutedTypes.length === 0;
  const nothing = on === 0;

  return (
    <section className="flex flex-col rounded-xl border p-5">
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">What prokes you</h2>
        {/*
          Keyed on the wording rather than the count, so arriving at "every kind" fades in once
          and a count that then changes swaps quietly instead of the line flickering per digit.
        */}
        <span
          key={everything ? "all" : "some"}
          className="animate-fade-in text-xs text-muted-foreground"
        >
          {everything ? "Every kind" : `${on} of ${NOTIFICATION_TYPES.length} kinds`}
        </span>
      </header>

      {/*
        A list per group rather than one list with headings inside it, so a heading is never a
        list item. The reel is handed the row's position in NOTIFICATION_TYPES, which is kept
        grouped and in group order - so that index is also where the row sits on screen, and the
        reel scrolls the way the eye just moved.
      */}
      <div className="-mx-2">
        {POKE_GROUPS.map((group, groupIndex) => (
          <section key={group.key}>
            <GroupHeader group={group} first={groupIndex === 0} />

            <ul>
              {NOTIFICATION_TYPES.filter(
                (descriptor) => descriptor.group === group.key
              ).map((descriptor) => {
                const index = NOTIFICATION_TYPES.indexOf(descriptor);

                const muted = mutedTypes.includes(descriptor.type);

                return (
                  <li key={descriptor.type}>
                    <TypeRow
                      descriptor={descriptor}
                      muted={muted}
                      active={index === activeIndex}
                      onShow={() => setActiveIndex(index)}
                      onToggle={() => onToggleType(descriptor.type)}
                    />
                    {descriptor.type === "review_requested" ? (
                      <StrictRow
                        strict={reviewRequestResolution === "strict"}
                        disabled={muted}
                        // The same poke as the row above, so the reel stays where it is.
                        onShow={() => setActiveIndex(index)}
                        onToggle={() =>
                          onSetReviewRequestResolution(
                            reviewRequestResolution === "strict"
                              ? "any_review"
                              : "strict"
                          )
                        }
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {/*
        The poke itself, as Slack will show it. The window's own top fade is the gap above it,
        so it needs no margin of its own - and no label, because a Slack message that says who
        did what is not a thing anybody needs told what it is.
      */}
      <PokeReel index={activeIndex} className="mt-4" />

      {/*
        Nothing under the list unless something has actually happened - a refused save, or every
        kind switched off. There is no standing footnote: the rows say what they do, and a line
        of explanation that is true on every visit is a line nobody reads by the second one.

        Muting everything is a choice somebody is allowed to make, so it is said plainly rather
        than argued with.
      */}
      {notice || nothing ? (
        <p
          className={cn(
            "mt-auto pt-4 text-[10px] leading-relaxed",
            notice ? "text-destructive" : "text-muted-foreground/60"
          )}
        >
          {notice ?? "Nothing will proke you. Turn a kind back on and it starts again."}
        </p>
      ) : null}
    </section>
  );
}

/**
 * A group's name, and nothing else.
 *
 * A per-group count lived here and was the control that muted the whole group. It went because
 * of what it did to the list at rest: three headings each reading "4 on" is the same fact
 * three times, next to nine rows that already show it one tick at a time, and the count in the
 * panel's own header answers it for the whole list anyway. What is left is a divider with a
 * word on it, which is all the grouping needs to do.
 */
function GroupHeader({ group, first }: { group: PokeGroup; first: boolean }) {
  return (
    <h3
      className={cn(
        "px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground",
        first ? "pt-1" : "pt-3"
      )}
    >
      {group.title}
    </h3>
  );
}

/** One kind: what it is, whether it reaches you, and - on hover - what it looks like in Slack. */
function TypeRow({
  descriptor,
  muted,
  active,
  onShow,
  onToggle,
}: {
  descriptor: NotificationTypeDescriptor;
  muted: boolean;
  active: boolean;
  onShow: () => void;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!muted}
      onMouseEnter={onShow}
      onFocus={onShow}
      onClick={() => {
        // Showing this row's poke as well as flipping it: a press with the keyboard has not
        // hovered anything, and the reel is the explanation of what was just switched off.
        onShow();
        onToggle();
      }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        active ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      <Octicon
        path={descriptor.icon}
        className={cn(
          "shrink-0 transition-colors",
          muted
            ? "text-muted-foreground/40"
            : active
              ? "text-foreground"
              : "text-muted-foreground"
        )}
      />
      {/*
        The title dims rather than striking through. A struck row reads as deleted, and this one
        is merely off - it is still a thing that exists and can come back with one press.
      */}
      <span
        className={cn(
          "flex-1 transition-colors",
          muted ? "text-muted-foreground/50" : undefined
        )}
      >
        {descriptor.title}
      </span>

      {/*
        The tick is the switch. An empty ring in its place keeps the row exactly as wide when it
        is off, so a column of them does not shuffle as they are pressed.
      */}
      <Tick on={!muted} />
    </button>
  );
}

/**
 * The switch under the review request: kept until GitHub stops asking you, or struck through at
 * the first review from anybody.
 *
 * Off is the default and reads as the quieter of the two, so the words describe the *on* state -
 * what pressing it buys - rather than naming a mode. Indented to sit under its parent's title
 * rather than its icon, which is what says it belongs to that row and not to the group. No
 * active highlight of its own: hovering it lights the parent, which is the poke it is about.
 */
function StrictRow({
  strict,
  disabled,
  onShow,
  onToggle,
}: {
  strict: boolean;
  disabled: boolean;
  onShow: () => void;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={strict}
      disabled={disabled}
      onMouseEnter={onShow}
      onFocus={onShow}
      onClick={() => {
        onShow();
        onToggle();
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg py-1 pl-9 pr-2 text-left text-xs transition-colors",
        disabled
          ? "cursor-default opacity-40"
          : "cursor-pointer hover:bg-accent/50"
      )}
    >
      <span
        className={cn(
          "flex-1 transition-colors",
          strict ? undefined : "text-muted-foreground/70"
        )}
      >
        Keep it until your review is no longer needed
      </span>
      <Tick on={strict} />
    </button>
  );
}

/** A tick, or the ring that holds its place. The same width either way, so nothing shuffles. */
function Tick({ on }: { on: boolean }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      {on ? (
        <Octicon path={CHECK} size={12} className="text-emerald-500/80" />
      ) : (
        <span
          aria-hidden="true"
          className="size-3 rounded-full border border-muted-foreground/30"
        />
      )}
    </span>
  );
}
