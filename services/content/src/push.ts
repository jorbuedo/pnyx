// PushSender implementations (the seam in front of FCM, see notifications.ts).
//
// Without FIREBASE_SERVICE_ACCOUNT the logging sender is active and every intent is fully
// produced/fanned out but only logged. Set it to the interim project's service-account JSON
// (inline or a file path) and the firebase-admin sender takes over — no other change needed.
//
// This is the Node path, which now means local dev only: the origin is the Worker, whose
// sender lives in push-worker.ts (no Node APIs there).
import fs from 'node:fs';
import { circleOf, type NotificationIntent, type PushSender } from './notifications.js';

const circleData = (intent: NotificationIntent): Record<string, string> => {
  const circle = circleOf(intent);
  return circle === undefined ? {} : { communityId: circle };
};

export const loggingPushSender = (log: (message: string) => void): PushSender => ({
  name: 'logging (FCM dry-run)',
  send: async (fcmToken, intent) => {
    log(
      `push[dry-run] → ${fcmToken.slice(0, 12)}… kind=${intent.kind} community=${
        circleOf(intent) ?? 'none'
      } title=${JSON.stringify(intent.payload.title ?? '')}`,
    );
  },
});

/**
 * Selects the sender from the environment. firebase-admin is imported lazily so the
 * dependency stays inert until a Firebase project exists.
 */
export const createPushSender = async (log: (message: string) => void): Promise<PushSender> => {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) {
    return loggingPushSender(log);
  }
  const credentials = serviceAccount.trim().startsWith('{')
    ? (JSON.parse(serviceAccount) as Record<string, unknown>)
    : (JSON.parse(fs.readFileSync(serviceAccount, 'utf8')) as Record<string, unknown>);
  const { cert, initializeApp } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  const app = initializeApp({ credential: cert(credentials as never) }, 'pnyx-content-push');
  const messaging = getMessaging(app);
  return {
    name: 'fcm',
    send: async (fcmToken: string, intent: NotificationIntent) => {
      await messaging.send({
        token: fcmToken,
        notification: {
          title: intent.payload.title ?? 'Pnyx',
          body: intent.payload.body ?? '',
        },
        // A DM has no circle, and FCM `data` takes strings only — so the key is omitted rather than
        // sent as an empty one, which a client would read as a real id.
        data: { ...intent.payload, kind: intent.kind, ...circleData(intent) },
      });
    },
  };
};
