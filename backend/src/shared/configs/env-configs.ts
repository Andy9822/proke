import 'dotenv/config';

interface EnvConfig {
  app: {
    port: number;
    // Where the frontend is served. OAuth redirects that land here get handed back to it, so
    // the browser finishes on the origin that actually holds the session.
    url: string;
  };
  mongo: {
    url: string;
  };
  auth: {
    jwtSecret: string;
    // Signs the OAuth `state` that ties a Slack round trip to one user. Deliberately not the
    // JWT secret: state travels through Slack's logs and a browser's history, and rotating one
    // of the two should not silently invalidate the other.
    stateSigningSecret: string;
    /**
     * How long an access token is good for, in seconds.
     *
     * Short, because it is the only credential that cannot be taken back: the guard verifies a
     * signature and asks nothing else, so a leaked one works until it expires no matter what
     * has happened to the account since. That is what the refresh token below buys - the long
     * half of the session is a row in Mongo, and deleting the row ends it.
     */
    accessTokenTtlSeconds: number;
    /**
     * How long a refresh token survives without being used, in milliseconds.
     *
     * Sliding, not absolute: every refresh pushes it out again, so somebody who opens proke at
     * least this often never logs in twice. It is what decides how long a laptop can be shut
     * before GitHub has to be asked again.
     */
    refreshTokenTtlMs: number;
  };
  crypto: {
    /**
     * Guards every third-party token at rest: the Slack bot token and, for every user, the
     * GitHub user-to-server token that proke asks GitHub with on that person's behalf.
     *
     * Not Slack-specific, and deliberately no longer named as if it were - see
     * readTokenEncryptionKey. It is not the same thing as auth.stateSigningSecret: this one
     * encrypts and can be reversed, that one only signs.
     */
    tokenEncryptionKey: string;
  };
  // Read from GH_APP_* rather than GITHUB_APP_*: GitHub reserves the GITHUB_ prefix for Actions
  // secrets, so a deploy would otherwise have to rename them on the way in.
  githubApp: {
    appId: string;
    // The app's URL slug, used to build the install link we send users to.
    slug: string;
    // User-to-server login. A GitHub App does its own OAuth-shaped flow; there is no
    // separate OAuth App any more.
    clientId: string;
    clientSecret: string;
    privateKey: string;
    webhookSecret: string;
  };
  slack: {
    clientId: string;
    clientSecret: string;
    // Signs the Events API requests, the way the webhook secret signs GitHub's.
    signingSecret: string;
    // Where Slack sends the user back after they authorize - a page in the frontend, which
    // then posts the code here. Slack refuses plain http, localhost included, so local
    // development needs a tunnel rather than the dev server's own URL.
    redirectUri: string;
  };
  posthog: {
    // Blank turns analytics off entirely rather than failing. See isAnalyticsConfigured.
    apiKey: string;
    host: string;
  };
  inbox: {
    /**
     * How often everybody's inbox is rebuilt, and nought to turn the sweep off entirely.
     *
     * Off is what the e2e suite wants: a timer reaching for GitHub in the background would make
     * every spec's mocks a race, so specs drive InboxWarmerService.sweep themselves.
     */
    warmSweepIntervalMs: number;
  };
  notifications: {
    /**
     * How long a review's pokes are held open so the rest of it can arrive. GitHub delivers a
     * review as one webhook per inline comment plus one for the submission, in no particular
     * order, so this is the price of them landing as a single message. The same window holds a
     * review request, which a team with review assignment on delivers twice - once as the team
     * and once per member it picks out by name.
     */
    reviewBatchWindowMs: number;
    /**
     * How often the digest sweep looks for somebody whose hour has come, and nought to turn it
     * off. Not how often anybody is messaged: the claim allows one digest per local day whatever
     * this is set to, so it only decides how soon after their hour they hear.
     */
    digestSweepIntervalMs: number;
  };
}

/**
 * Every fallback below that is a secret rather than a convenience. Local runs and the e2e suite
 * need no .env, so the defaults have to work - which means they are published in this repo, and
 * production has to refuse them rather than quietly accept them. See assertProductionEnv.
 */
const DEVELOPMENT_SECRETS = {
  jwtSecret: 'local-development-secret',
  stateSigningSecret: 'local-development-state-secret',
  tokenEncryptionKey: 'local-development-encryption-key',
} as const;

export function getEnvConfig(): EnvConfig {
  return {
    app: {
      // Uncommon defaults so a local run never fights another service for a port.
      port: Number(process.env.PORT ?? 48211),
      url: (process.env.APP_URL ?? 'http://localhost:49173').replace(/\/$/, ''),
    },
    mongo: {
      url: process.env.MONGO_URL ?? 'mongodb://localhost:47117/proke',
    },
    auth: {
      jwtSecret: process.env.AUTH_JWT_SECRET ?? DEVELOPMENT_SECRETS.jwtSecret,
      stateSigningSecret:
        process.env.STATE_SIGNING_SECRET ?? DEVELOPMENT_SECRETS.stateSigningSecret,
      // An hour. Long enough that a session spends almost all of its life not talking to
      // /auth/refresh, short enough that "log this person out" - a deleted account, a revoked
      // session - is true within the hour rather than within the week it used to be.
      accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 60 * 60),
      // Thirty days, sliding. proke is a thing you look at on working days, so anybody using it
      // at all keeps pushing this out; the people it logs out are the ones who stopped.
      refreshTokenTtlMs: Number(process.env.REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60_000),
    },
    githubApp: {
      appId: process.env.GH_APP_ID ?? '',
      slug: process.env.GH_APP_SLUG ?? '',
      clientId: process.env.GH_APP_CLIENT_ID ?? '',
      clientSecret: process.env.GH_APP_CLIENT_SECRET ?? '',
      privateKey: readPrivateKey(),
      webhookSecret: process.env.GH_APP_WEBHOOK_SECRET ?? '',
    },
    slack: {
      clientId: process.env.SLACK_CLIENT_ID ?? '',
      clientSecret: process.env.SLACK_CLIENT_SECRET ?? '',
      signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
      redirectUri: process.env.SLACK_REDIRECT_URI ?? '',
    },
    crypto: {
      // `||`, not `??`, for the same reason as posthog.host below: readTokenEncryptionKey
      // returns an empty string when neither name is set, and an empty key must fall through
      // to the development default rather than be handed to createHash as a real one.
      tokenEncryptionKey: readTokenEncryptionKey() || DEVELOPMENT_SECRETS.tokenEncryptionKey,
    },
    posthog: {
      apiKey: process.env.POSTHOG_API_KEY ?? '',
      // `||`, not `??`: the deploy passes POSTHOG_HOST unconditionally, so an unset repository
      // secret arrives as an empty string rather than as absent. `??` would let that through
      // and hand the SDK a blank host, which fails on every request instead of falling back.
      host: process.env.POSTHOG_HOST || 'https://eu.i.posthog.com',
    },
    inbox: {
      // Five minutes. Comfortably inside SNAPSHOT_TTL_MS, so a warmed inbox never expires between
      // sweeps, and slow enough that being kept warm costs a user 12 of their 5,000 hourly
      // GraphQL points. Configurable so a deploy can turn it off without a release.
      warmSweepIntervalMs: Number(process.env.INBOX_WARM_SWEEP_INTERVAL_MS ?? 5 * 60_000),
    },
    notifications: {
      // Five seconds: long enough that the pieces of one review reliably meet, short enough that
      // a poke is still a poke. Configurable mostly so the e2e suite need not sit through it.
      reviewBatchWindowMs: Number(process.env.REVIEW_BATCH_WINDOW_MS ?? 5000),
      // A quarter hour: the coarsest that still honours zones offset by half and three-quarter
      // hours, and four passes an hour means only a long deploy costs anybody their digest.
      digestSweepIntervalMs: Number(process.env.DIGEST_SWEEP_INTERVAL_MS ?? 15 * 60_000),
    },
  };
}

/**
 * Refuses to start on a production box that is missing anything it needs.
 *
 * The alternative is what this replaces: every secret had a working fallback, so a deploy that
 * dropped one booted perfectly and signed forgeable tokens, or encrypted other people's
 * workspace tokens under a key printed in this repository. It failed open and it failed quietly.
 *
 * Called before the Nest app is built, so a bad environment is a non-zero exit and a crash loop
 * the deploy can see, rather than a healthy-looking container serving something unsafe.
 */
export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const config = getEnvConfig();
  const problems: string[] = [];

  const required = (name: string, value: string) => {
    if (!value) {
      problems.push(`${name} is not set`);
    }
  };

  /**
   * Absent and "left at the value printed in this repository" are the same failure with two
   * causes, so only one of them is ever reported - a list that names the same variable twice
   * reads like two separate things to fix.
   */
  const requiredSecret = (name: string, rawValue: string, developmentDefault: string) => {
    const value = rawValue;

    if (!value) {
      problems.push(`${name} is not set`);
      return;
    }

    if (value === developmentDefault) {
      problems.push(`${name} is still the development default, which is public in this repository`);
    }
  };

  required('MONGO_URL', process.env.MONGO_URL ?? '');
  required('APP_URL', process.env.APP_URL ?? '');

  requiredSecret(
    'AUTH_JWT_SECRET',
    process.env.AUTH_JWT_SECRET ?? '',
    DEVELOPMENT_SECRETS.jwtSecret,
  );
  requiredSecret(
    'STATE_SIGNING_SECRET',
    process.env.STATE_SIGNING_SECRET ?? '',
    DEVELOPMENT_SECRETS.stateSigningSecret,
  );

  // Unconditional, and that is the whole point of the name it now has. This key encrypts every
  // user's GitHub token as well as the Slack bot token, so grouping it with the Slack checks
  // below meant a deploy with Slack half-configured started anyway and wrote every GitHub token
  // under the key printed in this file.
  requiredSecret(
    'TOKEN_ENCRYPTION_KEY',
    readTokenEncryptionKey(),
    DEVELOPMENT_SECRETS.tokenEncryptionKey,
  );

  required('GH_APP_ID', config.githubApp.appId);
  required('GH_APP_SLUG', config.githubApp.slug);
  required('GH_APP_CLIENT_ID', config.githubApp.clientId);
  required('GH_APP_CLIENT_SECRET', config.githubApp.clientSecret);
  required('GH_APP_PRIVATE_KEY', config.githubApp.privateKey);
  required('GH_APP_WEBHOOK_SECRET', config.githubApp.webhookSecret);

  // Slack stays optional as a whole - isSlackConfigured() exists so the dashboard can say "not
  // set up" instead of failing. But a half-configured Slack is worse than none: it would accept
  // an install and then reject every event it was sent.
  //
  // The encryption key used to be checked here too. It is not Slack's - see the unconditional
  // check above.
  if (isSlackConfigured()) {
    required('SLACK_SIGNING_SECRET', config.slack.signingSecret);
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with an incomplete environment:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }
}

/** Whether the Slack app is wired up at all. Everything user-facing degrades politely on false. */
export function isSlackConfigured(): boolean {
  const { clientId, clientSecret, redirectUri } = getEnvConfig().slack;

  return Boolean(clientId && clientSecret && redirectUri);
}

/**
 * Whether events go anywhere. False is a supported state, not a broken one: local runs and the
 * e2e suite have no key, and neither should be making network calls to PostHog.
 *
 * Deliberately absent from assertProductionEnv's required list. Everything else in there guards
 * something that fails *unsafely* when missing - a forgeable token, a public encryption key.
 * A missing analytics key loses numbers, and refusing to boot a notification product over lost
 * numbers is the wrong trade. main.ts warns about it instead, so it is visible rather than silent.
 */
export function isAnalyticsConfigured(): boolean {
  return Boolean(getEnvConfig().posthog.apiKey);
}

/**
 * The data-at-rest key, under either name.
 *
 * It was called SLACK_TOKEN_ENCRYPTION_KEY when Slack was the only thing it protected. It now
 * also encrypts every user's GitHub token, and the Slack-shaped name is what made it look like
 * a Slack concern - which is how its production check ended up inside `if (isSlackConfigured())`
 * and let a Slack-less deploy write GitHub tokens under a public key.
 *
 * Both names are read so the rename does not have to be simultaneous with the secret being
 * renamed in the deploy. Changing which value wins here would make every stored token
 * undecryptable, so the old name must keep working until it is gone everywhere.
 *
 * TODO: delete the SLACK_TOKEN_ENCRYPTION_KEY fallback once the deploy secret is renamed.
 *
 * Returns an empty string when neither is set, so the caller decides what absence means -
 * getEnvConfig falls back to the development default, assertProductionEnv refuses to start.
 */
function readTokenEncryptionKey(): string {
  return process.env.TOKEN_ENCRYPTION_KEY ?? process.env.SLACK_TOKEN_ENCRYPTION_KEY ?? '';
}

/**
 * A PEM is multi-line and .env files are not, so the key may arrive either as literal PEM
 * (with escaped newlines) or base64-encoded. Accept both rather than making the reader guess.
 */
function readPrivateKey(): string {
  const raw = process.env.GH_APP_PRIVATE_KEY ?? '';

  if (raw.length === 0) {
    return '';
  }

  if (raw.includes('-----BEGIN')) {
    return raw.replace(/\\n/g, '\n');
  }

  return Buffer.from(raw, 'base64').toString('utf8');
}
