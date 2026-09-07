import { SlackMessage } from '../../slack/app/slack-api.service';
import {
  GithubDiffStat,
  GithubNotificationNormalized,
  GithubReviewVerdict,
  isReviewVerdict,
  PokeResolution,
  PokeResolutionKind,
  PokeReviewer,
} from '../core/entities/github-notification.interface';
import { NotificationType } from '../core/entities/notification-type.enum';

/**
 * How much of a comment to relay. Long enough for a paragraph of real context, short enough
 * that a poke stays a poke - the message links to the whole thing, and somebody who wrote three
 * screens about your pull request is asking you to go and read them there.
 */
const MAX_EXCERPT_CHARS = 320;

/**
 * Where a repository owner's avatar may come from.
 *
 * Slack fetches every `image_url` itself when the message is posted and rejects the whole
 * message if it cannot - so an unexpected host is not a broken picture, it is a poke that never
 * arrives. Only the two GitHub serves avatars from are worth that risk.
 */
const AVATAR_HOSTS = ['avatars.githubusercontent.com', 'github.com'];

/** Slack draws context images at about 20px; twice that keeps it sharp without being a download. */
const AVATAR_SIZE = 48;

/**
 * Half a sentence: what somebody did, and the word that joins it to what they did it to.
 *
 * Split in two because one poke can be two of these at once - approving a pull request and
 * leaving notes on it is one act with two halves - and joining them needs the preposition to
 * belong to the last one. "approved and left 3 comments on X", never "approved on and left".
 *
 * The preposition is absent where the verb takes its object directly: "merged X", "approved X".
 */
interface Clause {
  verb: string;
  preposition?: string;
}

/**
 * The sentence up to the link, which finishes it. One line, always the same shape:
 * `<who> <did what to> <the thing>`.
 *
 * Issues and pull requests are not distinguished when somebody names you - being mentioned is
 * being mentioned, and the link says which it was.
 */
const LEAD: Record<NotificationType, (notification: GithubNotificationNormalized) => Clause> = {
  // Says the team where the ask went to a group. "requested your review" is a small lie when
  // nineteen other people got the same poke, and which team it came through is the one thing
  // that explains why it arrived on a pull request you have never seen.
  [NotificationType.ReviewRequested]: (notification) => ({
    verb: notification.teamHandle
      ? `requested @${notification.teamHandle}'s review`
      : 'requested your review',
    preposition: 'on',
  }),
  [NotificationType.ReviewSubmitted]: () => ({ verb: 'reviewed' }),
  [NotificationType.PullRequestMerged]: () => ({ verb: 'merged' }),
  // "enabled auto-merge on", never "is merging": the checks have not finished, and a poke that
  // promises an outcome they could still refuse is one that gets to be wrong.
  [NotificationType.AutoMergeEnabled]: () => ({ verb: 'enabled auto-merge', preposition: 'on' }),
  [NotificationType.PullRequestComment]: () => ({ verb: 'commented', preposition: 'on' }),
  // The same sentence, and deliberately so: the link that finishes it says whether it was an
  // issue or a pull request, so spelling it out here would only make the line longer.
  [NotificationType.IssueComment]: () => ({ verb: 'commented', preposition: 'on' }),
  // "replied to you", not "replied to your comment": the link goes straight to the reply, and
  // which of your comments it was is one click away rather than something to word around.
  //
  // "also replied" for everybody else in the thread, who was not replied *to* - GitHub points
  // every reply at the comment that opened the thread, so only one person in it was. The "also"
  // is the whole clause: it only parses for somebody already in the conversation, which is
  // exactly who receives this one. Longer wordings that name the thread outright read as
  // "replied in a thread you're in on Wire up webhooks #9" once the link follows the
  // preposition, and the collision is worse than the brevity.
  [NotificationType.CommentReply]: (notification) =>
    notification.threadStarter
      ? { verb: 'replied to you', preposition: 'on' }
      : { verb: 'also replied', preposition: 'on' },
  // Says the team where the naming went to a group, exactly as a review request does: "mentioned
  // you" would be a small lie when nobody wrote your handle, and which team it came through is
  // the one thing you want from an unexpected poke.
  [NotificationType.PullRequestMention]: mentioned,
  [NotificationType.IssueMention]: mentioned,
};

function mentioned(notification: GithubNotificationNormalized): Clause {
  return {
    verb: notification.teamHandle ? `mentioned @${notification.teamHandle}` : 'mentioned you',
    preposition: 'on',
  };
}

/**
 * A submitted review is the one poke whose news can be good or bad, so it is the one whose
 * marker says which way it went.
 */
const REVIEW: Record<GithubReviewVerdict, Clause & { icon: string }> = {
  approved: { icon: '✅', verb: 'approved' },
  changes_requested: { icon: '❌', verb: 'requested changes', preposition: 'on' },
};

/**
 * The marker a poke opens with, where its type alone decides it. A review's marker depends on
 * its verdict and comes from REVIEW instead.
 *
 * What it separates is what a poke asks of you: something waiting on you, somebody talking, or
 * news that is simply good. That is what a morning's Slack gets triaged on, and it is why the
 * three are worth telling apart before the sentence beside them is read.
 *
 * Being mentioned is deliberately unmarked. It arrives in a comment but it is not one - the
 * sentence already says you were named, and the same 💬 as a plain comment would flatten the
 * very difference the poke exists to draw.
 */
const LEAD_ICON: Partial<Record<NotificationType, string>> = {
  // Eyes: the one poke that is a request rather than a report.
  [NotificationType.ReviewRequested]: '👀',
  // A review that reached no verdict is somebody talking, and reads as one.
  [NotificationType.ReviewSubmitted]: '💬',
  [NotificationType.PullRequestComment]: '💬',
  [NotificationType.IssueComment]: '💬',
  [NotificationType.CommentReply]: '💬',
  [NotificationType.PullRequestMerged]: '🎉',
  // Read against the 🎉 that usually follows it minutes later: armed, then landed. An hourglass
  // says queued-behind-checks without claiming the merge has happened, which is the one thing
  // 🚀 or ✅ would get wrong. Distinct from 👀 too - that is pending on you, this is pending on CI.
  [NotificationType.AutoMergeEnabled]: '⏳',
};

/**
 * How a struck-through review request explains itself. Always the same shape - a bold label,
 * who, and a mark - so it is read at a glance rather than parsed.
 *
 * One label for both verdicts on purpose. What the struck-through message reports is that the
 * request is discharged, and it is discharged either way; whether the reviewer was happy is
 * news about the pull request, and the author has their own poke carrying it.
 *
 * A merge is not a review, so it does not claim to be one. The shape holds, the noun changes.
 */
const RESOLUTION: Record<PokeResolutionKind, { label: string; icon: string }> = {
  approved: { label: 'Reviewed by', icon: '✅' },
  changes_requested: { label: 'Reviewed by', icon: '✅' },
  merged: { label: 'Merged by', icon: '✅' },
  closed: { label: 'Closed by', icon: '🚫' },
  // The ask taken back by whoever made it. The same mark as a close, because it is the same
  // news to the reader: nothing here is waiting on you, and nobody looked at it.
  removed: { label: 'Withdrawn by', icon: '🚫' },
};

/**
 * What has happened to a review request since it was sent, where the message is being edited
 * rather than sent for the first time.
 *
 * Two fields rather than one, because they are two different kinds of news. A resolution makes
 * the request moot and strikes the message through; reviewers leave it standing and put a line
 * under it. Where both are given the resolution wins outright - a struck-through message is
 * explaining why it is struck through, not keeping a roster.
 */
export interface PokeMessageState {
  resolution?: PokeResolution;
  /** In the order they reviewed. */
  reviewers?: PokeReviewer[];
}

/**
 * The poke, and - where any is given - the news that has arrived since.
 *
 * Neither kind of news produces a different message. A resolution produces the same message
 * with its first line struck through and a line saying who settled it; a reviewer produces the
 * same message with a line saying who has been here. The point of editing rather than sending
 * a second poke is that the reader recognises what they are looking at without reading it again.
 */
export function buildPokeMessage(
  notification: GithubNotificationNormalized,
  state: PokeMessageState = {},
): SlackMessage {
  const review = verdict(notification);
  const deed = sentence(leadClauses(notification, review));

  // The person twice over: linked to their GitHub profile in the blocks, bare in the fallback,
  // which is read in banners that render no markup. Why a link at all is handleLink's story.
  const actor = notification.actorLogin ? `@${notification.actorLogin}` : 'Someone';
  const actorLinked = notification.actorLogin ? handleLink(notification.actorLogin) : 'Someone';

  const lead = `${actor} ${deed}`;
  const icon = leadIcon(notification, review);
  const label = subject(notification);
  const excerpt = notification.excerpt ? truncate(notification.excerpt) : undefined;
  const avatar = avatarUrl(notification.ownerAvatarUrl);
  const diff = notification.diff ? diffLabel(notification.diff) : undefined;
  const settled = state.resolution ? settledLabel(state.resolution) : undefined;
  const footer = settled ?? (state.reviewers?.length ? reviewedLabel(state.reviewers) : undefined);
  // Unbolded once it is struck through: bold under a strikethrough is heavier than the live
  // messages around it, which is backwards for the one message that no longer needs doing.
  const linked = link(notification.htmlUrl, label);
  const headline = `${icon}${actorLinked} ${escape(deed)} ${settled ? linked : `*${linked}*`}`;

  return {
    // Slack shows this, not the blocks, in the notification banner and the sidebar preview -
    // so it says the whole thing rather than being a "this message has no text" placeholder.
    // The size rides along: deciding whether to open a review request now or later is mostly a
    // question of how big it is, and the banner is where that decision gets made.
    //
    // A resolution goes in front rather than being struck through: this string is read in
    // places that render no formatting at all, where tildes are just tildes. Reviewers go at
    // the end, because the request is still the news and they are a footnote to it.
    text:
      (settled ? `${settled.plain} · ` : '') +
      `${icon}${lead} ${label} · ${notification.repositoryFullName}` +
      (diff ? ` (${diff})` : '') +
      (footer && !settled ? ` · ${footer.plain}` : ''),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          // Tildes around the whole line, link included. Slack strikes a span that contains a
          // link along with the text either side of it - what it will not do is format the
          // label from inside, which is why this wraps rather than reaching into the link.
          text: settled ? `~${headline}~` : headline,
        },
      },
      // Only when there are words. A review request and a merge have none, and a quote block
      // with nothing in it would read as a message that failed to load.
      ...(excerpt ? [{ type: 'section', text: { type: 'mrkdwn', text: quote(excerpt) } }] : []),
      {
        type: 'context',
        elements: [
          // The org's logo, read before the name beside it is. Left out rather than substituted
          // when there is none - a placeholder avatar says something false about who owns this.
          ...(avatar ? [{ type: 'image', image_url: avatar, alt_text: owner(notification) }] : []),
          { type: 'mrkdwn', text: escape(notification.repositoryFullName) },
          // Its own element, so Slack sets it apart from the name rather than running the two
          // together, and in backticks, which is what makes Slack colour it.
          ...(diff ? [{ type: 'mrkdwn', text: `\`${diff}\`` }] : []),
          // Last, so it reads as the outcome of everything above it rather than as a label on
          // the repository. Unstruck: it is the one part of this message that is still news.
          // Reviewers take the same seat, so that when a verdict finally lands the line the
          // reader already knows changes its mark rather than moving. Not escaped here - the
          // markup carries the reviewers' profile links, so the builders escape what needs it.
          ...(footer ? [{ type: 'mrkdwn', text: footer.markup }] : []),
        ],
      },
    ],
  };
}

/**
 * The marker the line opens with, with the trailing space that separates it from the words -
 * empty for the pokes that carry none, so the line starts at the actor's handle.
 */
function leadIcon(
  notification: GithubNotificationNormalized,
  review: (Clause & { icon: string }) | undefined,
): string {
  // The verdict wins where there is one: an approval that came with notes on it is an approval
  // first, and ✅ says more than 💬 about whether to open it now.
  const marker = review?.icon ?? LEAD_ICON[notification.type];

  return marker ? `${marker} ` : '';
}

/**
 * `*Reviewed by*: @ada ✅`. The half-line an edited poke gains.
 *
 * Twice, because it is read in two places: the block, where Slack renders the bold, and the
 * fallback text, where an asterisk is only ever an asterisk.
 *
 * Second person where the reader did it themselves - "Reviewed by: you", because "@you" is not
 * how anybody refers to themselves.
 */
function settledLabel(resolution: PokeResolution): { markup: string; plain: string } {
  const { label, icon } = RESOLUTION[resolution.kind];
  const who = resolution.bySelf
    ? { linked: 'you', plain: 'you' }
    : { linked: handleLink(resolution.actorLogin), plain: handle(resolution.actorLogin) };

  return footerLabel(label, `${who.linked} ${icon}`, `${who.plain} ${icon}`);
}

/**
 * `*Reviewed by*: @ada 💬, @grace ✅`. The same half-line, while the request still stands.
 *
 * The same label as a verdict and a different mark, on purpose: the reader learns one shape
 * and reads the mark. A speech bubble is somebody talking, which is exactly what a review
 * with no verdict is, and it is the same mark a comment poke opens with. Somebody who did
 * decide while the request stood anyway - the strict setting's case - carries the verdict's
 * own mark, ✅ or ❌: under an unstruck request, which way the person ahead of you went is the
 * one thing that decides whether to open it now.
 *
 * One mark per person rather than one for the line, so that the line stays readable as a list
 * of people rather than needing to be parsed as a sentence.
 */
function reviewedLabel(reviewers: PokeReviewer[]): { markup: string; plain: string } {
  const linked = reviewers
    .map((reviewer) => `${handleLink(reviewer.login)} ${reviewerMark(reviewer)}`)
    .join(', ');
  const plain = reviewers
    .map((reviewer) => `${handle(reviewer.login)} ${reviewerMark(reviewer)}`)
    .join(', ');

  return footerLabel('Reviewed by', linked, plain);
}

function reviewerMark(reviewer: PokeReviewer): string {
  return reviewer.verdict ? REVIEW[reviewer.verdict].icon : '💬';
}

function footerLabel(
  label: string,
  markup: string,
  plain: string,
): { markup: string; plain: string } {
  return { markup: `*${label}*: ${markup}`, plain: `${label}: ${plain}` };
}

/** How a person is named where GitHub told us who they are, and how where it did not. */
function handle(login: string | undefined): string {
  return login ? `@${login}` : 'someone';
}

/**
 * The same name, linked to the GitHub profile it belongs to - for the mrkdwn half of a message.
 *
 * The link does two jobs. It puts the right person one click away, and it stops Slack guessing:
 * left bare, an @-token gets matched against workspace usernames, which are frozen at signup
 * and outlive their accounts, so `@jsmith` routinely lights up a colleague's long-dead handle
 * instead of the GitHub user who actually acted.
 */
function handleLink(login: string | undefined): string {
  return login ? link(`https://github.com/${encodeURIComponent(login)}`, `@${login}`) : 'someone';
}

/** The message a finished connection produces, once, the moment the last piece lands. */
export function buildWelcomeMessage(githubLogin?: string): SlackMessage {
  const who = githubLogin ? handleLink(githubLogin) : 'you';

  return {
    text: 'proke is connected — this is where your prokes will arrive.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*proke is connected.* This is where GitHub prokes for ${who} will arrive.`,
        },
      },
    ],
  };
}

/**
 * The opening line of a test proke, drawn at random.
 *
 * The button gets pressed more than once - by the same person, on the same connection, after
 * every change to it - and the welcome message said its piece the first time. A line that is
 * different on every press is the difference between a receipt and a small reward for pressing
 * it, and it costs nothing that the line underneath does not already say plainly.
 *
 * Each one has to work as the only thing somebody reads, so none of them can be mistaken for a
 * pull request going quiet. The context line names the button either way.
 *
 * The word is always "proke", never "poke". It is the joke the product is named after, and a
 * line that drops the r is a line that reads as a typo in the other direction.
 */
const TEST_LINES = [
  '*This proke is a drill.* Review nothing. Merge nothing. As you were.',
  '*Knock knock.* Nobody there. proke is checking the door works.',
  '*A wild test proke appears.* It deals no damage. It is very proud of itself.',
  '*Testing, testing.* One proke, two proke. Slack can hear you.',
  '*Ping.* If you can read this, the plumbing holds and the proke got through.',
  '*Consider yourself proked.* No pull request, no comments, no obligations.',
  '*Proke delivered.* Somewhere a pull request is still waiting for a review. Not this one.',
];

/** The same line with the markup taken out, for the push notification, which renders none. */
function unbold(line: string): string {
  return line.replace(/\*/g, '');
}

/**
 * The message the Send a test proke button produces. Deliberately not a fake notification, and
 * deliberately not the welcome message either - somebody pressed a button, and the message says
 * so, so that a test proke is never read as news about a pull request.
 */
export function buildTestMessage(githubLogin?: string): SlackMessage {
  const line = TEST_LINES[Math.floor(Math.random() * TEST_LINES.length)];
  const who = githubLogin ? handleLink(githubLogin) : 'somebody';

  return {
    text: `${unbold(line)} (Test proke — ${handle(githubLogin)} pressed Send a test proke on the dashboard.)`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: line } },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Test proke · ${who} pressed *Send a test proke* on the dashboard. No pull request was involved.`,
          },
        ],
      },
    ],
  };
}

/**
 * What the link says: the title, then the number people actually use to refer to it. The
 * number alone is unreadable and the title alone is unsearchable.
 */
function subject(notification: GithubNotificationNormalized): string {
  const title = notification.title || 'View on GitHub';

  return notification.number ? `${title} #${notification.number}` : title;
}

/**
 * The verdict a submitted review reached, where it reached one.
 *
 * A review that neither approved nor blocked has no verdict and no marker - it is somebody
 * talking, and the words are in the quote underneath.
 */
function verdict(
  notification: GithubNotificationNormalized,
): (Clause & { icon: string }) | undefined {
  if (notification.type !== NotificationType.ReviewSubmitted) {
    return undefined;
  }

  return isReviewVerdict(notification.reviewState) ? REVIEW[notification.reviewState] : undefined;
}

/**
 * What this poke says somebody did - one clause, or two where a review came with notes on it.
 *
 * The review half always comes first, because it is the verdict on the whole change and the
 * comments are remarks inside it.
 */
function leadClauses(
  notification: GithubNotificationNormalized,
  review: Clause | undefined,
): Clause[] {
  // A submitted review without a verdict is still a review: "reviewed" is what LEAD holds for
  // it, and it belongs in front of the comments the same way an approval does.
  const first =
    review ??
    (notification.type === NotificationType.ReviewSubmitted
      ? LEAD[NotificationType.ReviewSubmitted](notification)
      : undefined);
  const rest = commentClause(notification, Boolean(first));

  if (first && rest) {
    return [first, rest];
  }

  return [first ?? rest ?? LEAD[notification.type](notification)];
}

/**
 * The clause that counts what was said, where a poke stands for more than one comment.
 *
 * Silent about a single comment that has nothing in front of it: "commented on" already says
 * that, and which of the two wordings you got should not depend on whether a webhook arrived
 * inside the batching window.
 */
function commentClause(
  notification: GithubNotificationNormalized,
  hasReview: boolean,
): Clause | undefined {
  const comments = notification.comments;

  if (!comments || (comments.count === 1 && !hasReview)) {
    return undefined;
  }

  if (comments.count === 1) {
    return comments.mentioned
      ? { verb: 'mentioned you', preposition: 'on' }
      : { verb: 'left a comment', preposition: 'on' };
  }

  return comments.mentioned
    ? { verb: `mentioned you in ${comments.count} comments`, preposition: 'on' }
    : { verb: `left ${comments.count} comments`, preposition: 'on' };
}

/** Joined with "and", and only the last clause keeps its preposition - the link follows it. */
function sentence(clauses: Clause[]): string {
  const preposition = clauses[clauses.length - 1].preposition;

  return (
    clauses.map((clause) => clause.verb).join(' and ') + (preposition ? ` ${preposition}` : '')
  );
}

/** Whoever owns the repository. The alt text for their avatar, and nothing else. */
function owner(notification: GithubNotificationNormalized): string {
  return notification.repositoryFullName.split('/')[0] || notification.repositoryFullName;
}

/**
 * The avatar Slack is allowed to go and fetch, sized down on the way.
 *
 * Anything unparseable, insecure or off GitHub is dropped rather than passed through: Slack
 * validates image URLs when the message is posted, and a rejected block would cost the whole
 * poke to gain a picture.
 */
function avatarUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:' || !AVATAR_HOSTS.includes(parsed.hostname)) {
      return undefined;
    }

    // GitHub serves whatever size is asked for, and the full-resolution original is several
    // hundred kilobytes to render at twenty pixels.
    parsed.searchParams.set('s', String(AVATAR_SIZE));

    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * `+163/-23`. How big the change is, in the shape everybody already reads it in.
 *
 * Grouped at the thousands because the difference between a four and a five digit diff is the
 * whole message at that size, and unseparated digits make it a thing to count rather than read.
 */
function diffLabel(diff: GithubDiffStat): string {
  return `+${group(diff.additions)}/-${group(diff.deletions)}`;
}

function group(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Slack draws a quote bar beside every line starting with `>`, and consecutive quoted lines
 * share one bar - so the prefix goes on each line, including the blank ones, or a comment with
 * a paragraph break comes out as two separate quotes.
 */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${escape(line)}` : '>'))
    .join('\n');
}

/** Cut on a word boundary where there is one nearby; a mid-word chop looks like a bug. */
function truncate(text: string): string {
  if (text.length <= MAX_EXCERPT_CHARS) {
    return text;
  }

  const cut = text.slice(0, MAX_EXCERPT_CHARS);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > MAX_EXCERPT_CHARS - 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Slack's mrkdwn link. The label is escaped; a `|` or `>` in a title would end the link early. */
function link(url: string, label: string): string {
  if (!url) {
    return escape(label);
  }

  return `<${url}|${escape(label).replace(/\|/g, '❘')}>`;
}

/**
 * Slack treats these three as markup, and pull request titles are user-written text that
 * regularly contains all of them - `<T> & <U>` would otherwise vanish into a broken tag.
 */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
