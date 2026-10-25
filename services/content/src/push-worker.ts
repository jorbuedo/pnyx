// Worker-safe push sender: FCM HTTP v1 over a service-account JWT.
//
// push.ts imports node:fs (the firebase-admin path) and cannot run on Workers, and firebase-admin
// itself is a Node library — so the Worker, which is the origin, does the two HTTP calls by hand:
// sign a service-account assertion, exchange it for an access token, then POST the message. `jose` is
// already a dependency (the ES256 session tokens), and RS256 signing is WebCrypto, so nothing new is
// pulled in.
//
// Scope: push only WAKES the app. Live circle/DM updates are the Durable Object socket's job, not a
// notification payload's (the `realtime-plane-durable-objects` memory), which is why the message
// carries a title/body and ids rather than content.
import { SignJWT, importPKCS8 } from 'jose';
import {
  channelForKind,
  circleOf,
  type NotificationIntent,
  type PushSender,
  UnregisteredDeviceError,
} from './notifications.js';

/**
 * The `android` block, present only for a kind that names its own channel.
 *
 * Spread rather than always sent: an empty `android.notification` would override nothing but says
 * something, and every other kind is meant to land on the client's manifest default.
 */
const androidChannel = (intent: NotificationIntent): Record<string, unknown> => {
  const channel = channelForKind(intent.kind);
  return channel === undefined ? {} : { android: { notification: { channel_id: channel } } };
};

const circleData = (intent: NotificationIntent): Record<string, string> => {
  const circle = circleOf(intent);
  return circle === undefined ? {} : { communityId: circle };
};

/** Dry-run sender: every intent is fully produced and fanned out, then logged instead of sent. */
export const workerPushSender = (log: (message: string) => void): PushSender => ({
  name: 'logging (FCM dry-run, worker)',
  send: async (fcmToken, intent) => {
    log(`push[dry-run] → ${fcmToken.slice(0, 12)}… kind=${intent.kind} community=${circleOf(intent) ?? 'none'}`);
  },
});

/** The fields we need from a Google service-account JSON. */
export type ServiceAccount = {
  readonly project_id: string;
  readonly client_email: string;
  /** PKCS#8 PEM. */
  readonly private_key: string;
  /** Defaults to Google's endpoint when the JSON omits it. */
  readonly token_uri?: string;
};

/**
 * Parse the service-account JSON, or explain what is missing.
 *
 * Throws rather than degrading: a half-configured sender that silently drops notifications is worse
 * than a deployment that refuses to start with a bad secret.
 */
export const parseServiceAccount = (raw: string): ServiceAccount => {
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch (error) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const missing = (['project_id', 'client_email', 'private_key'] as const).filter((k) => !parsed[k]);
  if (missing.length > 0) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is missing ${missing.join(', ')}`);
  }
  return parsed as ServiceAccount;
};

const TOKEN_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

export type AccessTokenSource = { token(): Promise<string> };

/**
 * Mint and cache a Google access token.
 *
 * Cached because it is valid for an hour and each mint costs an RSA signature plus a round trip;
 * refreshed a minute early so a token cannot expire mid-flight. Per-isolate, which is the right scope:
 * isolates are cheap and short-lived, and sharing this through a Durable Object would add a hop to
 * every notification to save a signature.
 */
export const accessTokenSource = (
  account: ServiceAccount,
  options: { readonly fetchImpl?: typeof fetch; readonly now?: () => number } = {},
): AccessTokenSource => {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const tokenUri = account.token_uri ?? DEFAULT_TOKEN_URI;
  let cached: { token: string; expiresAtMs: number } | undefined;

  return {
    token: async () => {
      if (cached !== undefined && cached.expiresAtMs > now()) return cached.token;
      const issuedAt = Math.floor(now() / 1000);
      const key = await importPKCS8(account.private_key, 'RS256');
      const assertion = await new SignJWT({ scope: TOKEN_SCOPE })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(account.client_email)
        .setAudience(tokenUri)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 3600)
        .sign(key);

      const res = await doFetch(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
      if (!res.ok) {
        throw new Error(`google token exchange failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
      }
      const body = (await res.json()) as { access_token?: string; expires_in?: number };
      if (typeof body.access_token !== 'string' || body.access_token === '') {
        throw new Error('google token exchange returned no access_token');
      }
      // Refresh a minute early rather than trusting a boundary we do not control.
      const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
      cached = { token: body.access_token, expiresAtMs: now() + Math.max(lifetime - 60, 30) * 1000 };
      return cached.token;
    },
  };
};

/**
 * The real sender: FCM HTTP v1.
 *
 * `data` values must all be strings — FCM rejects a data message otherwise — which is why
 * `NotificationIntent.payload` is a flat string map at the source rather than being stringified here.
 */
export const fcmPushSender = (options: {
  readonly account: ServiceAccount;
  readonly tokens: AccessTokenSource;
  readonly fetchImpl?: typeof fetch;
  readonly log: (message: string) => void;
}): PushSender => {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = `https://fcm.googleapis.com/v1/projects/${options.account.project_id}/messages:send`;
  return {
    name: 'fcm-http-v1',
    send: async (fcmToken, intent: NotificationIntent) => {
      const accessToken = await options.tokens.token();
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            notification: { title: intent.payload.title ?? 'Pnyx', body: intent.payload.body ?? '' },
            // A DM has no circle, and FCM `data` takes strings only — so the key is omitted rather
            // than sent as an empty one, which a client would read as a real id.
            data: { ...intent.payload, kind: intent.kind, ...circleData(intent) },
            ...androidChannel(intent),
          },
        }),
      });
      if (res.ok) return;
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      // 404 UNREGISTERED / 400 with an invalid-argument on the token both mean the install is gone.
      // Surfaced as its own error so the fan-out can eventually prune rather than paying for a dead
      // token on every notification forever.
      if (res.status === 404 || detail.includes('UNREGISTERED')) {
        throw new UnregisteredDeviceError(fcmToken);
      }
      throw new Error(`FCM send failed (${res.status}): ${detail}`);
    },
  };
};

/**
 * Pick the sender from the environment: the real one when a service account is configured, the
 * dry-run otherwise.
 *
 * A malformed secret throws — see {@link parseServiceAccount}. An *absent* one is a legitimate
 * configuration (local dev, a preview deployment with no project), and logs so a silent dry-run is
 * never a surprise.
 */
export const createWorkerPushSender = (
  serviceAccountJson: string | undefined,
  log: (message: string) => void,
  fetchImpl?: typeof fetch,
): PushSender => {
  if (serviceAccountJson === undefined || serviceAccountJson.trim() === '') {
    log('no FIREBASE_SERVICE_ACCOUNT configured — notifications are produced and logged, not sent');
    return workerPushSender(log);
  }
  const account = parseServiceAccount(serviceAccountJson);
  log(`FCM sender configured for project ${account.project_id}`);
  return fcmPushSender({
    account,
    tokens: accessTokenSource(account, ...(fetchImpl === undefined ? [] : [{ fetchImpl }])),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    log,
  });
};
