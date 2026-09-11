import { cn } from "@/lib/utils";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type ToggleEvent,
} from "react";

/** Between the edge of the trigger and the near edge of the list. */
const GAP_PX = 4;
/** How close to the bottom of the viewport the list may reach before it opens upwards instead. */
const VIEWPORT_MARGIN_PX = 8;

export interface SelectOption<T extends string> {
  value: T;
  /** The choice, in a word or two. What the trigger shows once it is picked. */
  title: string;
  /**
   * What picking it does, in one sentence. Shown under the title in the list, never on the
   * trigger. Optional, for lists where the title is the whole answer - an hour explains itself.
   */
  detail?: string;
}

export interface SelectProps<T extends string> {
  /** What is being chosen, in a word or two. Names the list for a screen reader. */
  label: string;
  options: readonly SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /**
   * What leads the trigger, before the current pick and the chevron - an icon and the label as
   * the reader sees it, usually. The trigger is a flex row, so give anything that should take
   * the slack `flex-1`.
   */
  children?: ReactNode;
  /**
   * For the trigger, which comes with no padding, text size or hover of its own: it is drawn
   * as a row in whatever list it sits in, and that list knows what its rows look like. The
   * list of options sizes itself to the trigger and takes nothing from here.
   */
  className?: string;
}

/**
 * A choice between a few named things, each with a line under it saying what it does.
 *
 * ## Why not a native `<select>`
 *
 * Because an option in one is a line of text, and the choices this is for are not: "Default" and
 * "Strict" mean nothing until the line under each says what it does, and a native menu has
 * nowhere to put that line. Everything else about a native select is kept - a trigger that
 * shows the current pick, a list that opens on press, one pick and it closes.
 *
 * The trigger is the whole row, not a box at the end of it. Where this sits, every other row is
 * a switch pressed anywhere along its length, and a select that only opened from its last word
 * would be the one row that behaved differently.
 *
 * ## What the browser owns
 *
 * The list is a popover, for the same reason FeedbackButton's panel is one: light dismissal,
 * Escape, the top layer, and focus handed back to the trigger on the way out are the parts that
 * are easy to get wrong and invisible when you do. What is left to do here is put the list where
 * the trigger is, and move focus between the options while it is open.
 *
 * ## Where the list goes
 *
 * Under the trigger, the same width, like a native menu. The popover sits in the top layer, so
 * it does not scroll with the page - anything that moves the trigger has to move it too, which
 * is what the scroll and resize listeners are for. It opens upwards only when there is no room
 * underneath, and that can only be known once it has a height, which is after it is shown -
 * so it is placed twice, and the second placement lands during the first frame of the entrance
 * animation, where the list is still transparent.
 */
export function Select<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  children,
  className,
}: SelectProps<T>) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const current = options.find((option) => option.value === value) ?? options[0];

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const list = listRef.current;

    if (!trigger || !list) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const below = rect.bottom + GAP_PX;
    // Zero before the list has been shown once, which reads as "fits" and puts it below.
    const fits = below + list.offsetHeight <= window.innerHeight - VIEWPORT_MARGIN_PX;

    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
    list.style.top = fits ? `${below}px` : "auto";
    list.style.bottom = fits ? "auto" : `${window.innerHeight - rect.top + GAP_PX}px`;
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);

    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const optionElements = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    );

  const handleBeforeToggle = (event: ToggleEvent<HTMLDivElement>) => {
    // Before the first paint, so the list is never seen anywhere but under its trigger.
    if (event.newState === "open") {
      place();
    }
  };

  const handleToggle = (event: ToggleEvent<HTMLDivElement>) => {
    const opened = event.newState === "open";

    setOpen(opened);

    if (!opened) {
      return;
    }

    // Now with a height, so the list can turn upwards if it has to.
    place();
    // Showing a popover does not move focus into it. Focus lands on the option that is already
    // picked, so the arrow keys start from there and a reflexive Enter changes nothing.
    const picked = options.findIndex((option) => option.value === value);
    optionElements()[Math.max(picked, 0)]?.focus();
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Enter and Space are the click, which the popover target already answers. The arrows are
    // how every other select opens, and they would otherwise scroll the page.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      listRef.current?.showPopover();
    }
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = optionElements();
    const focused = items.findIndex((item) => item === document.activeElement);
    let next: number;

    switch (event.key) {
      case "ArrowDown":
        next = Math.min(focused + 1, items.length - 1);
        break;
      case "ArrowUp":
        next = Math.max(focused - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    items[next]?.focus();
  };

  const pick = (next: T) => {
    // Closed first: the browser hands focus back to the trigger on the way out, and the parent
    // re-rendering under an open list is nothing anybody needs to see.
    listRef.current?.hidePopover();

    if (next !== value) {
      onChange(next);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        popoverTarget={listId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg text-left transition-colors",
          "focus-visible:outline-2 focus-visible:-outline-offset-2",
          disabled ? "cursor-default opacity-40" : "cursor-pointer",
          className
        )}
      >
        {children}
        {/*
          The pick, quieter than the words before it: it is the value of the row, not its name,
          and the chevron beside it is what says the value can be changed.
        */}
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          {current.title}
          <ChevronIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-200",
              open ? "rotate-180" : undefined
            )}
          />
        </span>
      </button>

      {/*
        Positioning only, exactly as FeedbackButton does it: `inset-auto m-0` hands the UA's
        centring back to `place`, `overflow-visible` stops the entrance's 6px of travel from
        drawing a scrollbar for the length of the animation. The card is the div inside.
      */}
      <div
        ref={listRef}
        id={listId}
        popover="auto"
        role="listbox"
        aria-label={label}
        tabIndex={-1}
        onBeforeToggle={handleBeforeToggle}
        onToggle={handleToggle}
        onKeyDown={handleListKeyDown}
        className="fixed inset-auto m-0 overflow-visible bg-transparent p-0 outline-none"
      >
        <div className="animate-rise-in rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl">
          {options.map((option) => {
            const selected = option.value === value;

            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                onClick={() => pick(option.value)}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                  "hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium leading-snug">
                    {option.title}
                  </span>
                  {option.detail ? (
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      {option.detail}
                    </span>
                  ) : null}
                </span>
                {/* The same width whether or not it is drawn, so the titles line up. */}
                <CheckIcon
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0 text-emerald-500/80",
                    selected ? undefined : "invisible"
                  )}
                />
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}
