// Content-plane endpoints: membership gating, per-circle personas (incl. unlinkability
// through the API), threads/replies, and the vote-once rule.
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtKeys } from './auth.js';
import { createNonceStore } from './nonce.js';
import { createNotifier } from './notifications.js';
import { loggingPushSender } from './push.js';
import { createHandler } from './routes.js';
import { disabledChainMirror } from './chain.js';
import { createContentStore } from './store.js';

let handler: (request: Request) => Promise<Response>;

// Exposed because this suite runs with `disabledChainMirror`, so anything a settlement would write
// has to be set directly — a test that POSTed `/chain/submit` here would get a 503 and then assert
// against state nothing wrote.
let store: ReturnType<typeof createContentStore>;

beforeAll(async () => {
  const keys = await createJwtKeys();
  store = createContentStore();
  handler = createHandler({
    auth: {
      domain: 'pnyx.test',
      network: 'undeployed',
      nonces: createNonceStore(),
      jwt: { privateKey: keys.privateKey, issuer: 'https://pnyx-content-service', audience: 'pnyx', ttlSeconds: 3600 },
    },
    publicJwk: keys.publicJwk,
    store,
    devAuth: true,
    chain: disabledChainMirror,
    notify: createNotifier(store, loggingPushSender(() => {}), () => {}),
  });
});

const req = (path: string, init?: RequestInit & { token?: string }) =>
  handler(
    new Request(`http://svc${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    }),
  );

const body = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const devLogin = async (name: string): Promise<string> => {
  const res = await req('/auth/dev', { method: 'POST', body: JSON.stringify({ name }) });
  expect(res.status).toBe(200);
  return (await body<{ token: string }>(res)).token;
};

const createCircle = async (token: string, name: string, persona?: string): Promise<string> => {
  const res = await req('/circles', { method: 'POST', token, body: JSON.stringify({ name, persona }) });
  expect(res.status).toBe(201);
  return (await body<{ circle: { id: string } }>(res)).circle.id;
};

describe('membership & personas', () => {
  it('creator auto-joins; non-members can read but not write', async () => {
    const alice = await devLogin('alice');
    const bob = await devLogin('bob');
    const circleId = await createCircle(alice, 'Treasury');

    const view = await body<{ membership: unknown; circle: { memberCount: number } }>(
      await req(`/circles/${circleId}`, { token: alice }),
    );
    expect(view.membership).toMatchObject({ persona: 'dev:alice', disclosed: true });
    expect(view.circle.memberCount).toBe(1);

    const denied = await req(`/circles/${circleId}/posts`, { method: 'POST', token: bob, body: JSON.stringify({ body: 'hi' }) });
    expect(denied.status).toBe(403);
  });

  it('pseudonymous personas never leak the subject through content reads', async () => {
    const carol = await devLogin('carol');
    const circleId = await createCircle(carol, 'Anon circle', 'night-owl');

    await req(`/circles/${circleId}/posts`, { method: 'POST', token: carol, body: JSON.stringify({ body: 'first!' }) });
    await req(`/circles/${circleId}/proposals`, { method: 'POST', token: carol, body: JSON.stringify({ title: 'p1' }) });

    const raw = JSON.stringify(await body(await req(`/circles/${circleId}`)));
    expect(raw).toContain('night-owl');
    expect(raw).not.toContain('carol');
  });

  it('rejects duplicate joins and taken persona labels', async () => {
    const dan = await devLogin('dan');
    const erin = await devLogin('erin');
    const circleId = await createCircle(dan, 'Rules', 'founder');

    const again = await req(`/circles/${circleId}/join`, { method: 'POST', token: dan, body: JSON.stringify({}) });
    expect(again.status).toBe(409);

    const taken = await req(`/circles/${circleId}/join`, { method: 'POST', token: erin, body: JSON.stringify({ persona: 'Founder' }) });
    expect(taken.status).toBe(409);

    const ok = await req(`/circles/${circleId}/join`, { method: 'POST', token: erin, body: JSON.stringify({ persona: 'lurker' }) });
    expect(ok.status).toBe(201);
  });

  it('leaves a circle, and the membership is gone rather than merely answered for', async () => {
    const gil = await devLogin('gil');
    const hana = await devLogin('hana');
    const circleId = await createCircle(gil, 'Departures', 'founder');
    await req(`/circles/${circleId}/join`, { method: 'POST', token: hana, body: JSON.stringify({ persona: 'hana' }) });

    const left = await req(`/circles/${circleId}/leave`, { method: 'POST', token: hana });
    expect(left.status).toBe(200);

    // ⚠️ The status alone would pass over a route that answered 200 and deleted nothing. What the
    // caller must see is the circle reporting no membership and a member count one lower.
    const after = (await body(await req(`/circles/${circleId}`, { token: hana }))) as {
      membership: unknown;
      circle: { memberCount: number };
    };
    expect(after.membership).toBeNull();
    expect(after.circle.memberCount).toBe(1);
  });

  it('refuses a leave from someone who never joined, rather than reporting a no-op as a departure', async () => {
    const ivan = await devLogin('ivan');
    const jo = await devLogin('jo');
    const circleId = await createCircle(ivan, 'Strangers', 'founder');

    const notAMember = await req(`/circles/${circleId}/leave`, { method: 'POST', token: jo });
    expect(notAMember.status).toBe(404);
  });

  it('requires authentication to leave, and a circle that exists', async () => {
    const kim = await devLogin('kim');
    const circleId = await createCircle(kim, 'Gone', 'founder');

    expect((await req(`/circles/${circleId}/leave`, { method: 'POST' })).status).toBe(401);
    expect(
      (await req('/circles/00000000-0000-0000-0000-000000000000/leave', { method: 'POST', token: kim })).status,
    ).toBe(404);
  });
});

describe('threads', () => {
  it('supports posts and replies, rejecting cross-circle parents', async () => {
    const frank = await devLogin('frank');
    const c1 = await createCircle(frank, 'Chat one');
    const c2 = await createCircle(frank, 'Chat two');

    const post = await body<{ post: { id: string } }>(
      await req(`/circles/${c1}/posts`, { method: 'POST', token: frank, body: JSON.stringify({ body: 'thread root' }) }),
    );
    const reply = await req(`/circles/${c1}/posts`, {
      method: 'POST',
      token: frank,
      body: JSON.stringify({ body: 'a reply', parentId: post.post.id }),
    });
    expect(reply.status).toBe(201);

    const crossCircle = await req(`/circles/${c2}/posts`, {
      method: 'POST',
      token: frank,
      body: JSON.stringify({ body: 'bad parent', parentId: post.post.id }),
    });
    expect(crossCircle.status).toBe(400);

    const view = await body<{ posts: { body: string; parentId?: string }[] }>(await req(`/circles/${c1}`));
    expect(view.posts).toHaveLength(2);
    expect(view.posts[1]?.parentId).toBe(post.post.id);
  });
});

describe('circle display character', () => {
  it('takes one grapheme including a multi-codepoint emoji, and refuses more than one', async () => {
    const owner = await devLogin('display-owner');
    const circleId = await createCircle(owner, 'Displayed', 'Founder');

    // ⚠️ Five code points, one character. Counting code points would reject exactly the emoji this
    // field exists to allow.
    const astronaut = '👩🏽‍🚀';
    const ok = await req(`/circles/${circleId}/display`, {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ displayChar: astronaut }),
    });
    expect(ok.status).toBe(200);
    expect((await body<{ circle: { displayChar?: string } }>(ok)).circle.displayChar).toBe(astronaut);

    for (const bad of ['AB', '👍👎', '', '   ']) {
      const res = await req(`/circles/${circleId}/display`, {
        method: 'POST',
        token: owner,
        body: JSON.stringify({ displayChar: bad }),
      });
      expect(res.status).toBe(400);
    }
    // The rejected attempts left the accepted one alone.
    const view = await body<{ circle: { displayChar?: string } }>(await req(`/circles/${circleId}`));
    expect(view.circle.displayChar).toBe(astronaut);
  });

  it('is founder-only', async () => {
    const owner = await devLogin('display-owner-2');
    const circleId = await createCircle(owner, 'Displayed two', 'Founder');
    const other = await devLogin('display-other');
    await req(`/circles/${circleId}/join`, { method: 'POST', token: other, body: JSON.stringify({ persona: 'other' }) });

    const denied = await req(`/circles/${circleId}/display`, {
      method: 'POST',
      token: other,
      body: JSON.stringify({ displayChar: '🎧' }),
    });
    expect(denied.status).toBe(403);
    expect((await store.getCircle(circleId))?.displayChar).toBeUndefined();
  });
});

describe('channels', () => {
  it('the founder creates one; a member cannot, and names are unique per circle', async () => {
    const ida = await devLogin('ida');
    const circleId = await createCircle(ida, 'Channelled', 'Founder');
    const joe = await devLogin('joe');
    await req(`/circles/${circleId}/join`, { method: 'POST', token: joe, body: JSON.stringify({ persona: 'joe' }) });

    const made = await req(`/circles/${circleId}/channels`, {
      method: 'POST',
      token: ida,
      body: JSON.stringify({ name: 'general' }),
    });
    expect(made.status).toBe(201);

    // ⚠️ A member is not a moderator. The founder is the persona the circle's constructor seated in
    // the on-chain `moderators` tree, and this route is the content-plane stand-in for that check.
    const denied = await req(`/circles/${circleId}/channels`, {
      method: 'POST',
      token: joe,
      body: JSON.stringify({ name: 'off-topic' }),
    });
    expect(denied.status).toBe(403);

    const duplicate = await req(`/circles/${circleId}/channels`, {
      method: 'POST',
      token: ida,
      body: JSON.stringify({ name: 'general' }),
    });
    expect(duplicate.status).toBe(409);

    const listed = await body<{ channels: { name: string }[] }>(await req(`/circles/${circleId}/channels`));
    expect(listed.channels.map((c) => c.name)).toEqual(['general']);
  });

  it('the founder renames one and clears its description; a member cannot', async () => {
    const nia = await devLogin('nia');
    const circleId = await createCircle(nia, 'Renamable', 'Founder');
    const oli = await devLogin('oli');
    await req(`/circles/${circleId}/join`, { method: 'POST', token: oli, body: JSON.stringify({ persona: 'oli' }) });
    const made = await body<{ channel: { id: string; description?: string } }>(
      await req(`/circles/${circleId}/channels`, {
        method: 'POST',
        token: nia,
        body: JSON.stringify({ name: 'chat', description: 'idle talk' }),
      }),
    );
    const channelId = made.channel.id;

    const denied = await req(`/circles/${circleId}/channels/${channelId}`, {
      method: 'POST',
      token: oli,
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(denied.status).toBe(403);

    const renamed = await body<{ channel: { name: string; description?: string } }>(
      await req(`/circles/${circleId}/channels/${channelId}`, {
        method: 'POST',
        token: nia,
        body: JSON.stringify({ name: 'lounge', description: 'still idle talk' }),
      }),
    );
    expect(renamed.channel.name).toBe('lounge');
    expect(renamed.channel.description).toBe('still idle talk');

    // ⚠️ An emptied field CLEARS the description rather than storing an empty string: the panel
    // renders an absent one as nothing, and `''` would reserve a line the founder just removed.
    // The status is asserted first so a regression reads as "this was rejected" rather than as a
    // TypeError on the missing body.
    const clearing = await req(`/circles/${circleId}/channels/${channelId}`, {
      method: 'POST',
      token: nia,
      body: JSON.stringify({ description: '' }),
    });
    expect(clearing.status).toBe(200);
    const cleared = await body<{ channel: { description?: string } }>(clearing);
    expect('description' in cleared.channel).toBe(false);

    // A name-only edit leaves the (now absent) description alone rather than resurrecting it.
    const nameOnly = await body<{ channel: { name: string; description?: string } }>(
      await req(`/circles/${circleId}/channels/${channelId}`, {
        method: 'POST',
        token: nia,
        body: JSON.stringify({ name: 'parlour' }),
      }),
    );
    expect(nameOnly.channel.name).toBe('parlour');
    expect('description' in nameOnly.channel).toBe(false);
  });

  it('refuses a rename that collides, that changes nothing, or that names another circle’s channel', async () => {
    const pia = await devLogin('pia');
    const circleId = await createCircle(pia, 'Collisions', 'Founder');
    const first = await body<{ channel: { id: string } }>(
      await req(`/circles/${circleId}/channels`, { method: 'POST', token: pia, body: JSON.stringify({ name: 'one' }) }),
    );
    await req(`/circles/${circleId}/channels`, { method: 'POST', token: pia, body: JSON.stringify({ name: 'two' }) });

    const collides = await req(`/circles/${circleId}/channels/${first.channel.id}`, {
      method: 'POST',
      token: pia,
      body: JSON.stringify({ name: 'two' }),
    });
    expect(collides.status).toBe(409);

    // Renaming to the name it already has is not a collision with itself.
    const noop = await req(`/circles/${circleId}/channels/${first.channel.id}`, {
      method: 'POST',
      token: pia,
      body: JSON.stringify({ name: 'one' }),
    });
    expect(noop.status).toBe(200);

    const empty = await req(`/circles/${circleId}/channels/${first.channel.id}`, {
      method: 'POST',
      token: pia,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    // ⚠️ Scoped by circle, so a founder cannot rename a channel belonging to a circle they do not
    // found by pairing their own circle id with someone else's channel id.
    const otherCircle = await createCircle(pia, 'Elsewhere', 'Founder');
    const elsewhere = await body<{ channel: { id: string } }>(
      await req(`/circles/${otherCircle}/channels`, {
        method: 'POST',
        token: pia,
        body: JSON.stringify({ name: 'theirs' }),
      }),
    );
    const crossed = await req(`/circles/${circleId}/channels/${elsewhere.channel.id}`, {
      method: 'POST',
      token: pia,
      body: JSON.stringify({ name: 'stolen' }),
    });
    expect(crossed.status).toBe(404);
  });

  it('gives channel authority to whoever settled the deploy, not to a matching label', async () => {
    // ⚠️ The label path is the legacy one, for circles settled before the founder was recorded. Once a
    // circle has a `founderSubject`, that subject is the authority — so a member who somehow held the
    // creator's label would still be refused, and the settling subject still allowed.
    const owner = await devLogin('anchor-owner');
    const circleId = await createCircle(owner, 'Anchored channels', 'Founder');
    // Set directly: `/chain/submit` 503s under this suite's disabled chain mirror, so routing through
    // it would leave `founderSubject` unset and every assertion below would pass on the *label*
    // fallback instead of the path under test.
    const ownerSubject = (await store.findSubjectByPersona(circleId, 'Founder')) as string;
    expect(ownerSubject).toBeDefined();
    await store.setCircleFounder(circleId, 'cd'.repeat(32), ownerSubject);

    const made = await req(`/circles/${circleId}/channels`, {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ name: 'anchored' }),
    });
    expect(made.status).toBe(201);

    // ⚠️ The founder's subject is their `C`. It must never reach a response, or a creator who chose a
    // display-name persona would be tied to their identity by the very row that hides it.
    const view = await body<Record<string, unknown>>(await req(`/circles/${circleId}`));
    expect(JSON.stringify(view)).not.toContain('founderSubject');
    const listed = await body<Record<string, unknown>>(await req('/circles'));
    expect(JSON.stringify(listed)).not.toContain('founderSubject');

    const other = await devLogin('anchor-other');
    await req(`/circles/${circleId}/join`, { method: 'POST', token: other, body: JSON.stringify({ persona: 'other' }) });
    const denied = await req(`/circles/${circleId}/channels`, {
      method: 'POST',
      token: other,
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(denied.status).toBe(403);

    // ⚠️ **The case that tells the two rules apart.** Above, the label holder and the settling subject
    // are the same person, so a gate reading either would pass — the assertions prove nothing about
    // which. Point `founderSubject` at the *other* member and the answers must swap: authority follows
    // the subject that settled the deploy, and the creator's label stops conferring it.
    const otherSubject = (await store.findSubjectByPersona(circleId, 'other')) as string;
    await store.setCircleFounder(circleId, 'cd'.repeat(32), otherSubject);

    const nowAllowed = await req(`/circles/${circleId}/channels`, {
      method: 'POST',
      token: other,
      body: JSON.stringify({ name: 'theirs' }),
    });
    expect(nowAllowed.status).toBe(201);

    const nowRefused = await req(`/circles/${circleId}/channels`, {
      method: 'POST',
      token: owner,
      body: JSON.stringify({ name: 'mine-no-longer' }),
    });
    expect(nowRefused.status).toBe(403);
  });

  it('files a post in a channel, refuses another circle’s, and leaves the default stream unlabelled', async () => {
    const kim = await devLogin('kim');
    const c1 = await createCircle(kim, 'Has channels');
    const c2 = await createCircle(kim, 'Other circle');
    const channel = await body<{ channel: { id: string } }>(
      await req(`/circles/${c1}/channels`, { method: 'POST', token: kim, body: JSON.stringify({ name: 'general' }) }),
    );
    const elsewhere = await body<{ channel: { id: string } }>(
      await req(`/circles/${c2}/channels`, { method: 'POST', token: kim, body: JSON.stringify({ name: 'general' }) }),
    );

    const filed = await req(`/circles/${c1}/posts`, {
      method: 'POST',
      token: kim,
      body: JSON.stringify({ body: 'in a channel', channelId: channel.channel.id }),
    });
    expect(filed.status).toBe(201);

    // A channel from another circle would file the post where none of this circle's members read.
    const wrongCircle = await req(`/circles/${c1}/posts`, {
      method: 'POST',
      token: kim,
      body: JSON.stringify({ body: 'misfiled', channelId: elsewhere.channel.id }),
    });
    expect(wrongCircle.status).toBe(400);

    await req(`/circles/${c1}/posts`, { method: 'POST', token: kim, body: JSON.stringify({ body: 'default stream' }) });

    const view = await body<{ posts: { body: string; channelId?: string }[]; channels: { name: string }[] }>(
      await req(`/circles/${c1}`),
    );
    expect(view.channels.map((c) => c.name)).toEqual(['general']);
    expect(view.posts.find((p) => p.body === 'in a channel')?.channelId).toBe(channel.channel.id);
    // Absent, not null and not a synthesised general: this post belongs to the circle's own stream.
    expect(view.posts.find((p) => p.body === 'default stream')?.channelId).toBeUndefined();
  });
});

describe('proposals & votes', () => {
  it('runs propose → vote with membership gating and vote-once', async () => {
    const grace = await devLogin('grace');
    const henk = await devLogin('henk');
    const outsider = await devLogin('outsider');
    const circleId = await createCircle(grace, 'Votes');
    await req(`/circles/${circleId}/join`, { method: 'POST', token: henk, body: JSON.stringify({ persona: 'anon-7' }) });

    const { proposal } = await body<{ proposal: { id: string } }>(
      await req(`/circles/${circleId}/proposals`, { method: 'POST', token: grace, body: JSON.stringify({ title: 'Fund it' }) }),
    );

    const vote = (token: string, value: string) =>
      req(`/proposals/${proposal.id}/vote`, { method: 'POST', token, body: JSON.stringify({ value }) });

    expect((await vote(grace, 'yes')).status).toBe(200);
    expect((await vote(henk, 'no')).status).toBe(200);
    expect((await vote(henk, 'yes')).status).toBe(409);
    expect((await vote(outsider, 'yes')).status).toBe(403);

    const view = await body<{ proposals: { tally: { yes: number; no: number }; hasVoted: boolean }[] }>(
      await req(`/circles/${circleId}`, { token: grace }),
    );
    expect(view.proposals[0]?.tally).toEqual({ yes: 1, no: 1 });
    expect(view.proposals[0]?.hasVoted).toBe(true);
  });
});

describe('auth boundaries', () => {
  it('rejects unauthenticated and bad-token writes; reads are public', async () => {
    expect((await req('/circles', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status).toBe(401);
    expect((await req('/circles', { method: 'POST', token: 'garbage', body: JSON.stringify({ name: 'x' }) })).status).toBe(401);
    expect((await req('/circles')).status).toBe(200);
  });
});

describe('CORS preflight', () => {
  it('answers OPTIONS with a body-less 204 carrying CORS headers', async () => {
    // Regression: a 204 built with any body (even JSON.stringify(null) === "null")
    // throws in the Fetch/Workers runtime, which surfaced as a 500 preflight and
    // blocked every browser client. The response must construct without throwing.
    const res = await req('/circles', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(await res.text()).toBe('');
  });
});

describe('a circle records whether it is gated', () => {
  it('defaults to open when the client says nothing', async () => {
    const token = await devLogin('gate-default');
    const created = await body<{ circle: { id: string; isOpen: boolean } }>(
      await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: 'Open', persona: 'a' }) }),
    );
    expect(created.circle.isOpen).toBe(true);
  });

  it('round-trips an invite-only circle through the list and the view', async () => {
    const token = await devLogin('gate-closed');
    const created = await body<{ circle: { id: string; isOpen: boolean } }>(
      await req('/circles', {
        method: 'POST',
        token,
        body: JSON.stringify({ name: 'Gated', persona: 'b', isOpen: false }),
      }),
    );
    expect(created.circle.isOpen).toBe(false);
    const view = await body<{ circle: { isOpen: boolean } }>(await req(`/circles/${created.circle.id}`));
    expect(view.circle.isOpen).toBe(false);
    const listed = await body<{ circles: readonly { id: string; isOpen: boolean }[] }>(await req('/circles'));
    expect(listed.circles.find((c) => c.id === created.circle.id)?.isOpen).toBe(false);
  });

  // Coerced would be worse than refused: the value is sealed into the contract's address, so a circle
  // whose row says gated and whose chain says open is a lie the UI would repeat.
  it('refuses a non-boolean gate rather than coercing it', async () => {
    const token = await devLogin('gate-bad');
    const res = await req('/circles', {
      method: 'POST',
      token,
      body: JSON.stringify({ name: 'Bad', persona: 'c', isOpen: 'false' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('a circle reports which compile its contract came from', () => {
  it('serves a template verdict on the list and the view', async () => {
    const token = await devLogin('tpl-shape');
    const created = await body<{ circle: { id: string; template: string } }>(
      await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: 'T', persona: 'a' }) }),
    );
    // Never settled, so there is no contract to have a digest — and "unknown" is the honest answer
    // rather than assuming the template matches.
    expect(created.circle.template).toBe('unknown');
    const view = await body<{ circle: { template: string } }>(await req(`/circles/${created.circle.id}`));
    expect(view.circle.template).toBe('unknown');
  });

  // The digest is the input to the verdict, not something a client can act on, and publishing it
  // would invite a comparison against a value this deployment never told them.
  it('never leaks the raw digest', async () => {
    const token = await devLogin('tpl-leak');
    const created = await body<{ circle: { id: string } }>(
      await req('/circles', { method: 'POST', token, body: JSON.stringify({ name: 'L', persona: 'b' }) }),
    );
    const view = await req(`/circles/${created.circle.id}`);
    expect(await view.text()).not.toContain('codeDigest');
  });
});
