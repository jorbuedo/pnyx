// The Worker's FCM sender: the token exchange and its caching, the message shape, and telling a dead
// token apart from a failed send.
//
// A real RSA key is generated per run rather than committed, so the assertion is genuinely signed —
// which is what proves the jose/WebCrypto path works on the runtime the Worker uses.
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type NotificationIntent, UnregisteredDeviceError } from './notifications.js';
import { accessTokenSource, createWorkerPushSender, fcmPushSender, parseServiceAccount } from './push-worker.js';

let account: { project_id: string; client_email: string; private_key: string; token_uri: string };

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  account = {
    project_id: 'pnyx-test',
    client_email: 'push@pnyx-test.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey),
    token_uri: 'https://oauth2.test/token',
  };
});

const intent: NotificationIntent = {
  subjectAddress: 'pnyx_id1abc',
  communityId: 'c1',
  kind: 'post-reply',
  payload: { title: 'A reply', body: 'someone replied', postId: 'p1' },
};

describe('parseServiceAccount', () => {
  it('names what is missing rather than half-configuring the sender', () => {
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow(/missing client_email, private_key/);
    expect(() => parseServiceAccount('not json')).toThrow(/is not JSON/);
  });
});

describe('accessTokenSource', () => {
  it('exchanges a signed assertion for an access token', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: 'ya29.test', expires_in: 3600 }));
    const source = accessTokenSource(account, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_000_000 });
    expect(await source.token()).toBe('ya29.test');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://oauth2.test/token');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    // A real signature over a real key: three base64url segments, and the claims we are asserting.
    const assertion = form.get('assertion') ?? '';
    expect(assertion.split('.')).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({
      iss: account.client_email,
      aud: 'https://oauth2.test/token',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
  });

  it('reuses a cached token instead of signing per notification', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ access_token: 'ya29.a', expires_in: 3600 }));
    let at = 1_000_000;
    const source = accessTokenSource(account, { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => at });
    await source.token();
    await source.token();
    expect(fetchImpl).toHaveBeenCalledOnce();

    // Refreshed a minute early, so a token cannot expire mid-flight.
    at += (3600 - 59) * 1000;
    await source.token();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports an exchange failure rather than returning an empty token', async () => {
    const source = accessTokenSource(account, {
      fetchImpl: (async () => new Response('invalid_grant', { status: 400 })) as unknown as typeof fetch,
      now: () => 0,
    });
    await expect(source.token()).rejects.toThrow(/token exchange failed \(400\)/);
  });
});

describe('fcmPushSender', () => {
  const tokens = { token: async () => 'ya29.test' };

  it('posts an HTTP v1 message with string-only data', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ name: 'projects/pnyx-test/messages/1' }));
    await fcmPushSender({
      account,
      tokens,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: () => {},
    }).send('device-token', intent);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/pnyx-test/messages:send');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ya29.test');
    const body = JSON.parse(String(init.body)) as { message: Record<string, unknown> };
    expect(body.message).toMatchObject({
      token: 'device-token',
      notification: { title: 'A reply', body: 'someone replied' },
      data: { postId: 'p1', kind: 'post-reply', communityId: 'c1' },
    });
    // FCM rejects a data message with non-string values, so nothing here may be a number or object.
    for (const value of Object.values((body.message as { data: Record<string, unknown> }).data)) {
      expect(typeof value).toBe('string');
    }
  });

  // A dead install must be distinguishable from a failed send, or we pay for it on every notification
  // forever.
  it('names the DM channel, which is all that survives Android drawing the notification itself', async () => {
    // An OS-drawn notification reaches the app with no data, so `kind` is gone by the time it is in
    // the tray. `channelId` is what is left to recognise a DM by, which is what lets the app stop
    // importing a row it can never clear.
    const fetchImpl = vi.fn(async () => Response.json({ name: 'projects/pnyx-test/messages/1' }));
    const dm: NotificationIntent = {
      subjectAddress: 'pnyx_id1abc',
      kind: 'dm-message',
      payload: { title: 'New message', body: 'You have a new direct message.' },
    };
    await fcmPushSender({ account, tokens, fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} }).send(
      'device-token',
      dm,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { message: { android?: unknown } };
    expect(body.message.android).toEqual({ notification: { channel_id: 'pnyx_dm' } });
  });

  it('leaves every other kind on the client default', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ name: 'projects/pnyx-test/messages/1' }));
    await fcmPushSender({ account, tokens, fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} }).send(
      'device-token',
      intent,
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { message: { android?: unknown } };
    expect(body.message.android).toBeUndefined();
  });

  it.each([
    [404, 'NOT_FOUND'],
    [400, 'error: UNREGISTERED'],
  ])('reports an unregistered token distinctly (%i)', async (status, detail) => {
    const sender = fcmPushSender({
      account,
      tokens,
      fetchImpl: (async () => new Response(detail, { status })) as unknown as typeof fetch,
      log: () => {},
    });
    await expect(sender.send('dead-token', intent)).rejects.toThrow(UnregisteredDeviceError);
  });

  it('reports any other failure with its status', async () => {
    const sender = fcmPushSender({
      account,
      tokens,
      fetchImpl: (async () => new Response('quota', { status: 429 })) as unknown as typeof fetch,
      log: () => {},
    });
    await expect(sender.send('t', intent)).rejects.toThrow(/FCM send failed \(429\)/);
  });
});

describe('createWorkerPushSender', () => {
  it('falls back to the dry-run sender, saying so, when no account is configured', () => {
    const log = vi.fn();
    expect(createWorkerPushSender(undefined, log).name).toContain('dry-run');
    expect(log.mock.calls[0]?.[0]).toContain('no FIREBASE_SERVICE_ACCOUNT');
  });

  it('uses FCM when an account is configured', () => {
    expect(createWorkerPushSender(JSON.stringify(account), () => {}).name).toBe('fcm-http-v1');
  });

  // A malformed secret is a deployment error, not a reason to silently stop sending notifications.
  it('throws on a malformed account rather than degrading', () => {
    expect(() => createWorkerPushSender('{"project_id":"only"}', () => {})).toThrow(/missing/);
  });
});
