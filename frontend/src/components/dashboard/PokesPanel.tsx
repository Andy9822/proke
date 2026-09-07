import {
  NOTIFICATION_TYPES,
  Octicon,
  POKE_GROUPS,
  POKE_ROWS,
  type NotificationTypeDescriptor,
  type PokeGroup,
  type PokeRow,
} from "@/components/notifications/notificationTypes";
import { PokeReel } from "@/components/notifications/PokeReel";
import { Select, type SelectOption } from "@/components/ui/Select";
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
 * Under the review request sits a row about the same poke: whether it is crossed out at the
 * first review from anybody, or kept until GitHub stops asking you. It is drawn like the nine
 * around it, with a select where they have a tick, because what it asks has two answers rather
 * than yes or no. It is not counted in the header, because it is not a kind - it changes what
 * happens to a poke after it has arrived, not whether it arrives - and its card in the reel is
 * that poke a little later, struck through. It goes quiet when the request itself is off:
 * there is nothing to cross out.
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
        list item. The reel is handed the row's position in POKE_ROWS, which is kept grouped and
        in group order - so that index is also where the row sits on screen, and the reel
        scrolls the way the eye just moved.
      */}
      <div className="-mx-2">
        {POKE_GROUPS.map((group, groupIndex) => (
          <section key={group.key}>
            <GroupHeader group={group} first={groupIndex === 0} />

            <ul>
              {POKE_ROWS.filter((row) => row.group === group.key).map((row) => {
                const index = POKE_ROWS.indexOf(row);
                const active = index === activeIndex;
                const onShow = () => setActiveIndex(index);

                if (row.kind === "resolution") {
                  return (
                    <li key="review_request_resolution">
                      <ResolutionRow
                        row={row}
                        resolution={reviewRequestResolution}
                        // Nothing to cross out while the request itself is switched off.
                        disabled={mutedTypes.includes("review_requested")}
                        active={active}
                        onShow={onShow}
                        onChange={onSetReviewRequestResolution}
                      />
                    </li>
                  );
                }

                return (
                  <li key={row.descriptor.type}>
                    <TypeRow
                      descriptor={row.descriptor}
                      muted={mutedTypes.includes(row.descriptor.type)}
                      active={active}
                      onShow={onShow}
                      onToggle={() => onToggleType(row.descriptor.type)}
                    />
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
 * The two answers to "when is a review request crossed out", in the panel's words.
 *
 * The values are the wire's and the names are not: `any_review` is what the server stores, and
 * "Default" is what it is to the person choosing - the answer nearly every team wants, and the
 * one an untouched account already has. Each carries the line that makes it mean something,
 * because "Strict" on its own is a word, not a setting.
 */
const REVIEW_REQUEST_RESOLUTIONS: readonly SelectOption<ReviewRequestResolution>[] = [
  {
    value: "any_review",
    title: "Default",
    detail: "The first review from anybody crosses it out.",
  },
  {
    value: "strict",
    title: "Strict",
    detail: "Stays until you review, or GitHub stops asking you.",
  },
];

/**
 * The row that is a setting rather than a kind: when a review request poke is crossed out.
 *
 * Drawn like the rows around it - icon, title, the reel following the pointer - with a select
 * where they have a tick. A select rather than the switch this replaced, because the switch had
 * one line to describe its on state - "keep it until your review is no longer needed" - and
 * that line was doing two jobs badly: naming a mode and explaining it. The select names the
 * mode on the row and explains both where they are chosen, each in a sentence of its own.
 *
 * The whole row opens the list, the way the whole of every other row is its switch. Quiet while
 * the request itself is off: there is nothing to cross out. It still lights and shows its card
 * under the pointer, though - the card is the explanation of what the setting would do.
 */
function ResolutionRow({
  row,
  resolution,
  disabled,
  active,
  onShow,
  onChange,
}: {
  row: Extract<PokeRow, { kind: "resolution" }>;
  resolution: ReviewRequestResolution;
  disabled: boolean;
  active: boolean;
  onShow: () => void;
  onChange: (resolution: ReviewRequestResolution) => void;
}) {
  return (
    // onFocus bubbles in React, so focus landing on the trigger or on an option in the open
    // list both keep the reel on this row. On a wrapper rather than the trigger because a
    // disabled button fires no mouse events of its own, and the card should still show.
    <div onMouseEnter={onShow} onFocus={onShow}>
      <Select
        label={row.title}
        options={REVIEW_REQUEST_RESOLUTIONS}
        value={resolution}
        onChange={onChange}
        disabled={disabled}
        className={cn(
          "px-2 py-1.5 text-sm",
          active ? "bg-accent" : disabled ? undefined : "hover:bg-accent/50"
        )}
      >
        <Octicon
          path={row.icon}
          className={cn(
            "shrink-0 transition-colors",
            active ? "text-foreground" : "text-muted-foreground"
          )}
        />
        <span className="flex-1">{row.title}</span>
      </Select>
    </div>
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
