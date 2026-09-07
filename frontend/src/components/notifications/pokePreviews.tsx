/**
 * What a poke looks like where it lands: in Slack, from proke, as a direct message.
 *
 * These mirror `buildPokeMessage` on the backend line for line - the same leads ("requested your
 * review on", "merged", "mentioned you on"), the same ✅/❌ markers on a submitted review, the
 * repository underneath. If that file's wording changes, this one is what has gone stale.
 *
 * Every card is deliberately the same shape and therefore the same height: the reel that stacks
 * them scrolls by whole rows and would drift if one of them were taller. That is also why the
 * message is one truncating line rather than a real Slack quote block.
 */

export interface PokePreview {
  /**
   * The icon the real message opens with - 👀 for a request, 💬 for somebody talking, 🎉 for a
   * merge, ⏳ for auto-merge, ✅/❌ for a review's verdict. Absent on a mention, which the
   * builder leaves unmarked on purpose: the sentence already says you were named, and a 💬
   * would flatten the difference the poke exists to draw. See LEAD_ICON in slack-message.ts.
   */
  marker?: string;
  actor: string;
  /** The lead, minus the actor - "merged", "commented on", "requested your review on". */
  lead: string;
  subject: string;
  repository: string;
  /**
   * What has happened since, where the message was edited rather than sent again: the first
   * line is struck through and this sits at the end of the footer, `*Reviewed by*: @rob ✅`,
   * as settledLabel spells it. Only the card about the resolution setting carries one - it is
   * the one thing a switch's card cannot show, what happens to a poke after it has arrived.
   */
  settled?: { label: string; actor: string; marker: string };
}

export function PokeCard({ preview }: { preview: PokePreview }) {
  return (
    <div className="flex w-full items-start gap-2.5 rounded-xl border bg-card/40 p-3.5 text-left">
      {/*
        The app icon itself, not an impression of one - it is the same file Slack is given and
        renders beside a real poke, so the mock cannot drift from what people actually see.
      */}
      <img
        src="/proke-p.svg"
        alt=""
        width={24}
        height={24}
        className="mt-0.5 size-6 shrink-0 rounded"
      />

      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          proke
          <span className="rounded bg-muted px-1 py-px text-[9px] font-normal uppercase tracking-wider text-muted-foreground">
            App
          </span>
        </p>

        {/*
          One line, always. In a wide card it is the whole sentence; in the dashboard's narrow
          column it ellipsises, which is what Slack itself does at that width - and either way
          the card is the same height, which the reel depends on.
        */}
        <p className="truncate text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
          {/*
            One line through the whole sentence, marker and link included, as Slack draws it.
            Not `line-through`: a decoration is drawn in the colour of the element declaring
            it, which here is the muted paragraph, and it sits where the font's metrics put it,
            which for this face is well above the middle of the words. See `strike` in
            index.css for the line that is drawn instead.
          */}
          <span className={preview.settled ? "strike" : undefined}>
            {preview.marker ? `${preview.marker} ` : null}
            <span className="text-foreground">@{preview.actor}</span>{" "}
            {preview.lead} <span className="text-blue-400">{preview.subject}</span>
          </span>
        </p>

        {/*
          The footer is one line in Slack too - repository, then whatever has happened since,
          laid out along it rather than under it - which is what keeps this card the height of
          the others. Unstruck, like the real one: it is the part that is still news.
        */}
        <p className="truncate text-[10px] text-muted-foreground/60">
          {preview.repository}
          {preview.settled ? (
            <span className="ml-2">
              <span className="font-medium text-muted-foreground">
                {preview.settled.label}
              </span>
              : @{preview.settled.actor} {preview.settled.marker}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/**
 * The run-up. Pokes stacked above the real ones purely so the reel has something to fly through
 * on its way in - they go past blurred and are never landed on, which is why they can be any
 * plausible poke at all, including shapes no single setting is about: a team asked for a review,
 * a team named in a comment. Those are real pokes with no switch of their own, because being
 * named through a group is not a different kind of news from being named outright.
 */
export const POKE_INTRO_PREVIEWS: PokePreview[] = [
  {
    actor: "sam",
    marker: "👀",
    lead: "requested your review on",
    subject: "Bump pnpm to 10.15 #503",
    repository: "acme/api",
  },
  {
    marker: "❌",
    actor: "lee",
    lead: "requested changes on",
    subject: "Split the router #495",
    repository: "acme/api",
  },
  {
    actor: "kit",
    marker: "🎉",
    lead: "merged",
    subject: "Trim the webhook payload #492",
    repository: "acme/web",
  },
  {
    actor: "sam",
    marker: "💬",
    lead: "commented on",
    subject: "Add a health endpoint #488",
    repository: "acme/api",
  },
  {
    actor: "lee",
    lead: "mentioned you on",
    subject: "Flaky e2e on CI #486",
    repository: "acme/web",
  },
  {
    marker: "✅",
    actor: "kit",
    lead: "approved",
    subject: "Move the queue off cron #484",
    repository: "acme/api",
  },
  {
    actor: "ada",
    marker: "🎉",
    lead: "merged",
    subject: "Send prokes as blocks #479",
    repository: "acme/api",
  },
  {
    actor: "nina",
    marker: "👀",
    lead: "requested your review on",
    subject: "Rate limit the webhook #476",
    repository: "acme/web",
  },
  {
    actor: "rob",
    marker: "💬",
    lead: "commented on",
    subject: "Keep the DM channel cached #471",
    repository: "acme/api",
  },
  {
    actor: "sam",
    lead: "mentioned you on",
    subject: "Slack install needs an owner #68",
    repository: "acme/web",
  },
  {
    marker: "❌",
    actor: "ada",
    lead: "requested changes on",
    subject: "Drop the polling worker #465",
    repository: "acme/api",
  },
  {
    actor: "kit",
    marker: "🎉",
    lead: "merged",
    subject: "Encrypt bot tokens at rest #461",
    repository: "acme/api",
  },
  {
    actor: "rob",
    lead: "mentioned @acme/reviewers on",
    subject: "Drop the legacy uploader #501",
    repository: "acme/api",
  },
  {
    actor: "kit",
    marker: "👀",
    lead: "requested @acme/reviewers's review on",
    subject: "Move the queue off cron #484",
    repository: "acme/api",
  },
];
