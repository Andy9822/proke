/*
 * `import type`, and it has to stay that way. This file is reached from the global analytics
 * module, so a value import here would point analytics at a feature and complete a cycle -
 * delivery already imports MetricsService, which imports this. Type-only, TypeScript erases it
 * and no `require` is emitted.
 *
 * Worth the care rather than redeclaring the union locally: the dimension *is* the delivery
 * outcome, and a second copy would drift from it silently - which shows up as a chart that
 * disagrees with the code about how many ways a poke can fail.
 */
import type { SlackDeliveryOutcome } from '../notifications/delivery/slack-notification-delivery.service';

/**
 * Every metric the backend sends, and the dimensions each one carries.
 *
 * The sibling of analytics-events.ts, and deliberately shaped like it - a union rather than an
 * enum, so a name reads as itself at the call site and a typo is a compile error. Two things
 * differ, and both are forced by what metrics are:
 *
 *  - **No central prefix.** Events are all `backend_*` without exception, so AnalyticsService
 *    can apply that in one place. Here `http.server.duration` is an OpenTelemetry convention and
 *    has to stay unprefixed to chart against anything else that speaks OTel, so the full name is
 *    written out and the `proke.` prefix is a convention rather than a rule the code enforces.
 *
 *  - **The shape is part of the type.** A metric name means one of a counter, a gauge or a
 *    histogram, and recording the same name as two of them blends both into one chart. Splitting
 *    the union three ways makes that unrepresentable rather than a warning at runtime.
 *
 * ## The rule every attribute below obeys
 *
 * A series is `name + type + unit + every attribute value`, and the flush window holds a thousand
 * of them across the whole process before it starts dropping new ones - silently, past one
 * warning. So an attribute may only ever take values from a set that is closed and small: an
 * event name, a status code, a reason. Never a user id, a repository, an installation, a pull
 * request number. Those questions are answered by events, which carry identity properly, and by
 * the `distinctId` on them.
 *
 * Everything unbounded that reaches this file is therefore funnelled through the `*Label`
 * helpers at the bottom, which map anything unrecognised onto `other`. That is the difference
 * between a new GitHub event type costing one series and costing the whole budget.
 */

/** Counters. Things that only go up. */
export type CounterName =
  | 'proke.webhook.received'
  | 'proke.poke.dropped'
  | 'proke.poke.delivered'
  | 'proke.cache.lookups'
  | 'proke.inbox.warmed'
  | 'proke.inbox.warm.sweeps'
  | 'proke.digest.sent'
  | 'proke.digest.sweeps';

/** Gauges. A value that moves both ways, read at a moment. */
export type GaugeName = 'proke.event_loop.delay';

/**
 * Histograms. A distribution worth percentiles.
 *
 * Every one of these is a duration in milliseconds, which is why MetricsService exposes them as
 * `duration()` rather than `histogram()` - no call site has to remember to pass the unit, and
 * none of them can pass a different one.
 */
export type HistogramName =
  | 'proke.inbox.warm.duration'
  | 'proke.digest.duration'
  | 'proke.webhook.duration'
  | 'proke.poke.latency'
  | 'proke.github.request.duration'
  | 'proke.slack.request.duration'
  | 'http.server.duration';

export type MetricName = CounterName | GaugeName | HistogramName;

/**
 * Why a poke that was going to be sent was not.
 *
 * The one metric that makes the whole routing funnel visible, because every one of these is
 * today a `continue`, a `logger.debug` or nothing at all.
 *
 * ## These are stage counts, not a partition - read them as a shape, not as a sum
 *
 * The unit changes halfway down the pipeline, and it has to. Above `groupByUser` a drop is one
 * *candidate*, and one person can be several: the author of a pull request who is also mentioned
 * in it arrives twice. At `groupByUser` those collapse to one recipient, which is the whole point
 * of grouping - one person gets one poke - and every reason below it therefore counts *people*.
 *
 * So `bot_chatter` and `not_subscribed` are not directly comparable, and the reasons do not add
 * up to the candidates that entered. The early ones run high relative to the late ones, because
 * most candidates were never going to be anybody. Comparing a reason against itself over time is
 * the question this answers well; reading the bars against each other as shares of one total is
 * the question it answers badly.
 *
 * There is deliberately no reason for "this event concerned nobody". That is not a dropped poke,
 * it is an event that never produced one, and mixing the two would make even the shape useless.
 */
export type PokeDropReason =
  /** The payload carried no installation, so nothing could authorise the poke. */
  | 'no_installation'
  /** A bot talking. The single largest source of the noise this product exists to stop. */
  | 'bot_chatter'
  /** `@org/team` named a team we could not read - no such team, not visible, or too big. */
  | 'team_unresolved'
  /** A reply whose parent comment we could not attribute to anybody. */
  | 'reply_unresolved'
  /** GitHub asked the author's own team to review the author's own pull request. */
  | 'author_review_request'
  /** Reachable on GitHub, but has never signed up. The common case, and not a problem. */
  | 'not_a_user'
  /** Nobody is told about their own action. */
  | 'self'
  /** Signed up, but has not opted into this installation. */
  | 'not_subscribed'
  /** Opted in to this installation, but has muted this notification type or this repository. */
  | 'muted'
  /**
   * Switched this kind of poke off account-wide, so no organisation was ever going to deliver
   * it. Apart from `muted` because the two are different decisions wearing the same outcome:
   * one is about this org, the other is about the kind of news itself.
   */
  | 'type_muted'
  /** GitHub says this person cannot see the repository. Working as intended. */
  | 'no_repo_access'
  /**
   * GitHub could not be asked - a revoked token, a rate limit, an outage - and the access check
   * fails closed. Working as designed and still a lost notification, which is why it is counted
   * apart from `no_repo_access`: one is a decision, the other is a failure wearing its clothes.
   */
  | 'access_unknown';

/** Whether the detached webhook handler finished or threw. */
export type WebhookOutcome = 'ok' | 'failed';

/**
 * What became of one person's inbox on one pass of the inbox warmer.
 *
 * One per person per sweep, which is also one per GitHub query - the sweep builds one view
 * each, the one their settings say. Nobody the activity gate excluded appears here at all: that
 * decision is made by Mongo in the query, so there is nothing on this side to count.
 *
 * `no_token` and `github_unavailable` are apart because only one of them is anybody's problem.
 * The first is a revoked authorization and stays broken until the person reconnects; the second
 * is GitHub having a bad minute and fixes itself by the next sweep. `failed` is neither - it is
 * this code throwing, which is a bug.
 */
export type WarmOutcome = 'refreshed' | 'no_token' | 'github_unavailable' | 'failed';

/**
 * Whether a whole pass ran.
 *
 * `overlapped` is the one worth watching: it means a sweep was still running when the next was
 * due, which is how this feature degrades - silently, because the sweep that overran is the one
 * that never records a duration.
 */
export type WarmSweepOutcome = 'completed' | 'overlapped' | 'failed';

/**
 * What one person's digest came to.
 *
 * `empty` is the healthy majority rather than a failure, and kept apart from `sent` because the
 * ratio between them says whether the digest is worth sending at all. `claimed_already` on a
 * single-instance deploy would mean the claim is not doing its job.
 */
export type DigestOutcome =
  | 'sent'
  | 'empty'
  | 'claimed_already'
  | 'no_token'
  | 'github_unavailable'
  | 'undeliverable'
  | 'failed';

/**
 * Which GitHub call this was. Hand-written labels rather than URLs, which carry ids.
 *
 * One per call site in the codebase; adding a twelfth means adding it here, which is the point -
 * the alternative is a label derived from the URL, and every such derivation eventually lets a
 * repository name through.
 */
export type GithubEndpoint =
  | 'app_installation_token'
  | 'app_installation_delete'
  | 'oauth_access_token'
  | 'user'
  | 'user_emails'
  | 'user_installations'
  | 'user_installation_repositories'
  | 'org_membership'
  | 'repo'
  | 'pull_request'
  | 'review_comment'
  | 'team_members'
  | 'user_teams'
  | 'team_membership'
  /* The inbox, which is one GraphQL request rather than one per pull request. */
  | 'graphql_inbox';

/** The Slack Web API methods proke calls, plus the OAuth exchange that is not one of them. */
export const SLACK_METHODS = [
  'chat.postMessage',
  'chat.update',
  'conversations.open',
  'users.identity',
  'oauth.access',
] as const;

export type SlackMethod = (typeof SLACK_METHODS)[number] | 'other';

/**
 * What one Slack request came to.
 *
 * One record per HTTP request rather than per logical call, so a rate-limited attempt and the
 * retry behind it are two records - which makes `rate_limited` a straight count of 429s.
 */
export type SlackOutcome = 'ok' | 'rate_limited' | 'dead_workspace' | 'dead_link' | 'error';

/** The in-memory cache's key namespaces. Anything unrecognised is `other`, never the key. */
export const CACHE_NAMESPACES = [
  'installation-token',
  'repo-access',
  'comment-author',
  'thread-participants',
  'team-members',
  'pr-diff',
  'teammates',
  'inbox-snapshot',
] as const;

export type CacheNamespace = (typeof CACHE_NAMESPACES)[number] | 'other';

/**
 * `coalesced` is its own answer rather than a hit or a miss: it is a caller that arrived while
 * the same key was already loading and shared that load. Deduplicating those is the whole reason
 * `wrap` exists rather than get-then-set, so it is worth being able to see it work.
 */
export type CacheResult = 'hit' | 'miss' | 'coalesced';

/**
 * Which reading of the event loop delay this is.
 *
 * Three series rather than a histogram because Node already keeps the histogram; re-recording it
 * into another one would mean replaying samples we do not have. The mean says how loaded the
 * process is; p99 is where a detached webhook handler blocking the loop actually shows up.
 */
export type EventLoopQuantile = 'mean' | 'p50' | 'p99';

/**
 * What a poke was about, for `proke.poke.delivered`.
 *
 * Wider than NotificationType for the same reason PokeTrigger is: the dashboard's test button
 * and the message proving a fresh connection works both go out the same pipe, and neither is a
 * notification. Carrying them here means the `trigger` dimension is not needed at all - `test`
 * and `welcome` already tell those two apart from everything else.
 */
export type DeliveredPokeType = string;

/** The attributes each metric carries. Required: none of these is meaningful undimensioned. */
export interface MetricAttributeMap {
  'proke.webhook.received': { event: string; action: string };
  'proke.webhook.duration': { event: string; outcome: WebhookOutcome };
  'proke.poke.dropped': { reason: PokeDropReason };
  'proke.poke.delivered': { type: DeliveredPokeType; outcome: SlackDeliveryOutcome };
  'proke.poke.latency': { type: string };
  'proke.github.request.duration': { endpoint: GithubEndpoint; status: string };
  'proke.slack.request.duration': { method: SlackMethod; outcome: SlackOutcome };
  'proke.cache.lookups': { namespace: CacheNamespace; result: CacheResult };
  'proke.inbox.warmed': { result: WarmOutcome };
  'proke.inbox.warm.sweeps': { outcome: WarmSweepOutcome };
  // Undimensioned: there is one sweep, and splitting it by anything would only make the series
  // smaller without making it answer a different question.
  'proke.inbox.warm.duration': Record<string, never>;
  'proke.digest.sent': { outcome: DigestOutcome };
  'proke.digest.sweeps': { outcome: WarmSweepOutcome };
  'proke.digest.duration': Record<string, never>;
  'proke.event_loop.delay': { quantile: EventLoopQuantile };
  'http.server.duration': { route: string; method: string; status: string };
}

/**
 * The GitHub events proke is subscribed to. Anything else is `other`.
 *
 * The header this comes from is not attacker-controlled - signature verification runs first - but
 * GitHub adds event types over time, and an app whose subscriptions are widened one afternoon
 * should not quietly widen the series budget with them.
 */
const KNOWN_WEBHOOK_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'issues',
  'installation',
  'installation_repositories',
];

/** The actions proke branches on, plus the installation lifecycle. */
const KNOWN_WEBHOOK_ACTIONS = [
  'opened',
  'closed',
  'created',
  'deleted',
  'edited',
  'submitted',
  'review_requested',
  'review_request_removed',
  'auto_merge_enabled',
  'added',
  'removed',
  'synchronize',
  'suspend',
  'unsuspend',
];

export function webhookEventLabel(event: unknown): string {
  return KNOWN_WEBHOOK_EVENTS.includes(String(event)) ? String(event) : 'other';
}

/** `none` rather than `other` where there was no action at all - some events carry none. */
export function webhookActionLabel(action: unknown): string {
  if (action === undefined || action === null || action === '') {
    return 'none';
  }

  return KNOWN_WEBHOOK_ACTIONS.includes(String(action)) ? String(action) : 'other';
}

export function slackMethodLabel(method: string): SlackMethod {
  return (SLACK_METHODS as readonly string[]).includes(method) ? (method as SlackMethod) : 'other';
}

/**
 * The namespace out of a cache key - `github:repo-access:...` is `repo-access`.
 *
 * Matched against the known list rather than trusted, because the rest of the key is a user id
 * and a repository name. A key nobody added to CACHE_NAMESPACES costs one series called `other`,
 * not one per user.
 */
export function cacheNamespaceLabel(key: string): CacheNamespace {
  const candidate = key.split(':')[1];

  return (CACHE_NAMESPACES as readonly string[]).includes(candidate)
    ? (candidate as CacheNamespace)
    : 'other';
}
