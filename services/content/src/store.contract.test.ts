// ContentStore contract — the same behavioural suite runs against both backends:
// - the JSON/in-memory store (the Node server's local store), and
// - the D1 store (Cloudflare, via miniflare — the production content plane).
import { readdirSync, readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createD1ContentStore } from './d1-store.js';
import { DM_RETENTION } from './dm-retention.js';
import { type ContentStore, createContentStore } from './store.js';

type Backend = { name: string; make: () => ContentStore };

const backends: Backend[] = [{ name: 'json', make: () => createContentStore() }];

// D1 backend: a local miniflare D1 with the real migrations applied. Runs every
// time (no external deployment needed), so the contract guards D1 in CI.
const mf = new Miniflare({ modules: true, script: 'export default {};', d1Databases: { DB: ':memory:' } });
let d1: D1Database;
beforeAll(async () => {
  d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(new URL(file, dir), 'utf8');
    const statements = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, '')) // strip full-line AND inline comments
      .join('\n')
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) await d1.exec(stmt);
  }
});
afterAll(async () => {
  await mf.dispose();
});
backends.push({ name: 'd1', make: () => createD1ContentStore({ db: d1 }) });

const unique = () => crypto.randomUUID().slice(0, 8);

describe.each(backends)('ContentStore contract ($name)', ({ make }) => {
  it('creates circles with the creator auto-joined and lists them newest-first', async () => {
    const store = make();
    const marker = unique();
    const circle = await store.createCircle({
      name: `Circle ${marker}`,
      description: 'desc',
      subject: `dev:owner-${marker}`,
      persona: `owner-${marker}`,
      disclosed: false,
      isOpen: true,
    });
    expect(circle.memberCount).toBe(1);
    expect(circle.author).toBe(`owner-${marker}`);

    const fetched = await store.getCircle(circle.id);
    expect(fetched).toMatchObject({ id: circle.id, name: `Circle ${marker}`, memberCount: 1 });

    const listed = await store.listCircles();
    expect(listed.some((c) => c.id === circle.id)).toBe(true);
    const createdAts = listed.map((c) => c.createdAt);
    expect([...createdAts].sort((a, b) => b.localeCompare(a))).toEqual(createdAts);

    expect(await store.getMembership(circle.id, `dev:owner-${marker}`)).toMatchObject({
      persona: `owner-${marker}`,
      disclosed: false,
    });
    expect(await store.getCircle('00000000-dead-beef-0000-000000000000')).toBeUndefined();
  });

  it('enforces join-once and case-insensitive persona uniqueness per circle', async () => {
    const store = make();
    const marker = unique();
    const circle = await store.createCircle({
      name: `Join rules ${marker}`,
      description: '',
      subject: `dev:a-${marker}`,
      persona: `founder-${marker}`,
      disclosed: false,
      isOpen: true,
    });

    expect(
      await store.join({ circleId: circle.id, subject: `dev:a-${marker}`, persona: `x-${marker}`, disclosed: true }),
    ).toBe('already-joined');
    expect(
      await store.join({
        circleId: circle.id,
        subject: `dev:b-${marker}`,
        persona: `FOUNDER-${marker}`,
        disclosed: false,
      }),
    ).toBe('persona-taken');

    const joined = await store.join({
      circleId: circle.id,
      subject: `dev:b-${marker}`,
      persona: `lurker-${marker}`,
      disclosed: true,
    });
    expect(joined).toMatchObject({ persona: `lurker-${marker}`, disclosed: true });
    expect((await store.getCircle(circle.id))?.memberCount).toBe(2);
  });

  it('runs proposals with vote-once and tallies', async () => {
    const store = make();
    const marker = unique();
    const owner = `dev:o-${marker}`;
    const voter = `dev:v-${marker}`;
    const circle = await store.createCircle({
      name: `Votes ${marker}`,
      description: '',
      subject: owner,
      persona: `o-${marker}`,
      disclosed: false,
      isOpen: true,
    });
    await store.join({ circleId: circle.id, subject: voter, persona: `v-${marker}`, disclosed: false });

    const proposal = await store.createProposal({
      circleId: circle.id,
      title: `Fund ${marker}`,
      body: 'body',
      author: `o-${marker}`,
    });
    expect(proposal.tally).toEqual({ yes: 0, no: 0 });
    expect((await store.listProposals(circle.id)).some((p) => p.id === proposal.id)).toBe(true);

    const afterYes = await store.castVote({ proposalId: proposal.id, subject: owner, value: 'yes' });
    expect(afterYes).toMatchObject({ tally: { yes: 1, no: 0 } });
    const afterNo = await store.castVote({ proposalId: proposal.id, subject: voter, value: 'no' });
    expect(afterNo).toMatchObject({ tally: { yes: 1, no: 1 } });
    expect(await store.castVote({ proposalId: proposal.id, subject: voter, value: 'yes' })).toBe('already-voted');

    expect(await store.hasVoted(proposal.id, owner)).toBe(true);
    expect(await store.hasVoted(proposal.id, `dev:nobody-${marker}`)).toBe(false);
    expect((await store.getProposal(proposal.id))?.tally).toEqual({ yes: 1, no: 1 });
  });

  it('stores posts and replies ordered oldest-first', async () => {
    const store = make();
    const marker = unique();
    const circle = await store.createCircle({
      name: `Threads ${marker}`,
      description: '',
      subject: `dev:t-${marker}`,
      persona: `t-${marker}`,
      disclosed: false,
      isOpen: true,
    });
    const root = await store.createPost({ circleId: circle.id, body: 'root', author: `t-${marker}` });
    const reply = await store.createPost({ circleId: circle.id, parentId: root.id, body: 'reply', author: `t-${marker}` });
    expect(reply.parentId).toBe(root.id);
    expect(await store.getPost(root.id)).toMatchObject({ id: root.id, body: 'root' });

    const posts = await store.listPosts(circle.id);
    expect(posts.map((p) => p.id)).toEqual([root.id, reply.id]);
  });

  it('round-trips chain refs on every entity', async () => {
    const store = make();
    const marker = unique();
    const subject = `dev:c-${marker}`;
    const circle = await store.createCircle({
      name: `Chain ${marker}`,
      description: '',
      subject,
      persona: `c-${marker}`,
      disclosed: false,
      isOpen: true,
    });
    const proposal = await store.createProposal({ circleId: circle.id, title: 'p', body: '', author: `c-${marker}` });
    await store.castVote({ proposalId: proposal.id, subject, value: 'yes' });

    await store.setCircleChain(circle.id, { status: 'confirmed', chainId: '7', txId: 'tx1' });
    await store.setMembershipChain(circle.id, subject, { status: 'pending' });
    await store.setProposalChain(proposal.id, { status: 'failed', error: 'boom' });
    await store.setVoteChain(proposal.id, subject, { status: 'confirmed', txId: 'tx2' });

    expect((await store.getCircle(circle.id))?.chain).toMatchObject({ status: 'confirmed', chainId: '7', txId: 'tx1' });
    expect((await store.getMembership(circle.id, subject))?.chain).toMatchObject({ status: 'pending' });
    expect((await store.getProposal(proposal.id))?.chain).toMatchObject({ status: 'failed', error: 'boom' });
    expect(await store.getVoteChain(proposal.id, subject)).toMatchObject({ status: 'confirmed', txId: 'tx2' });
  });

  it('stores device registrations (upsert by token) and resolves fan-out lookups', async () => {
    const store = make();
    const marker = unique();
    const owner = `dev:do-${marker}`;
    const circle = await store.createCircle({
      name: `Devices ${marker}`,
      description: '',
      subject: owner,
      persona: `do-${marker}`,
      disclosed: false,
      isOpen: true,
    });
    await store.join({ circleId: circle.id, subject: `dev:dm-${marker}`, persona: `dm-${marker}`, disclosed: false });

    await store.registerDevice(owner, { fcmToken: `tok-${marker}-a`, platform: 'android' });
    await store.registerDevice(owner, { fcmToken: `tok-${marker}-b`, platform: 'ios' });
    await store.registerDevice(owner, { fcmToken: `tok-${marker}-a`, platform: 'web' }); // upsert
    const devices = await store.listDevices(owner);
    expect(devices).toHaveLength(2);

    // A token the push provider calls dead has to be forgettable, or every later notification for
    // this subject pays for an install that no longer exists.
    await store.removeDevice(`tok-${marker}-a`);
    expect(await store.listDevices(owner)).toHaveLength(1);
    // Idempotent: the provider can report the same dead token on more than one notification.
    await store.removeDevice(`tok-${marker}-a`);
    await store.removeDevice(`tok-${marker}-never-existed`);
    expect(await store.listDevices(owner)).toHaveLength(1);
    expect(devices.find((d) => d.fcmToken === `tok-${marker}-a`)?.platform).toBe('web');
    expect(await store.listDevices(`dev:nobody-${marker}`)).toEqual([]);

    expect((await store.listMemberSubjects(circle.id)).sort()).toEqual([`dev:dm-${marker}`, owner].sort());
    expect(await store.findSubjectByPersona(circle.id, `dm-${marker}`)).toBe(`dev:dm-${marker}`);
    expect(await store.findSubjectByPersona(circle.id, `ghost-${marker}`)).toBeUndefined();
  });

  it('surfaces failed chain tasks in the dependency-ordered backlog', async () => {
    const store = make();
    const marker = unique();
    const owner = `dev:bo-${marker}`;
    const voter = `dev:bv-${marker}`;
    const circle = await store.createCircle({
      name: `Backlog ${marker}`,
      description: '',
      subject: owner,
      persona: `bo-${marker}`,
      disclosed: false,
      isOpen: true,
    });
    await store.join({ circleId: circle.id, subject: voter, persona: `bv-${marker}`, disclosed: false });
    const proposal = await store.createProposal({ circleId: circle.id, title: 'b', body: '', author: `bo-${marker}` });
    await store.castVote({ proposalId: proposal.id, subject: voter, value: 'no' });

    await store.setCircleChain(circle.id, { status: 'confirmed', chainId: '9', txId: 't' });
    await store.setMembershipChain(circle.id, voter, { status: 'failed', error: 'x' });
    await store.setProposalChain(proposal.id, { status: 'failed', error: 'x' });
    await store.setVoteChain(proposal.id, voter, { status: 'failed', error: 'x' });

    const backlog = await store.listChainBacklog();
    expect(backlog).toContainEqual({ kind: 'membership', circleId: circle.id, subject: voter });
    expect(backlog).toContainEqual({
      kind: 'proposal',
      circleId: circle.id,
      proposalId: proposal.id,
      authorSubject: owner,
    });
    expect(backlog).toContainEqual({
      kind: 'vote',
      circleId: circle.id,
      proposalId: proposal.id,
      subject: voter,
      value: 'no',
    });
    // Dependency ordering holds globally: memberships before proposals before votes.
    const kinds = backlog.map((item) => item.kind);
    expect(kinds.indexOf('vote')).toBeGreaterThan(kinds.indexOf('proposal'));

    // Neutralize the synthetic failures so a shared deployment's boot replay
    // (services/content restart recovery) never re-enqueues these fake tasks.
    await store.setMembershipChain(circle.id, voter, { status: 'confirmed', txId: 'contract-test' });
    await store.setProposalChain(proposal.id, { status: 'confirmed', chainId: '0', txId: 'contract-test' });
    await store.setVoteChain(proposal.id, voter, { status: 'confirmed', txId: 'contract-test' });
  });
});

// ── Direct messages (migration 0003_dm.sql) ──
// The delivery layer's invariants, not MLS's: single-use KeyPackages, idempotent re-upload,
// single-use Welcomes, and a cursor that does not re-deliver. Ciphertext is opaque here by design.
describe.each(backends)('ContentStore DM contract ($name)', ({ make }) => {
  // The D1 backend shares one database across `make()` calls while the JSON backend is fresh each
  // time, so every test namespaces its own subjects and conversation — otherwise a leftover
  // KeyPackage from an earlier test makes "pool is empty" assertions pass or fail by ordering.
  let n = 0;
  const ns = (): {alice: string; bob: string; conv: string; kp: (s: string) => string} => {
    n += 1;
    return {
      alice: `mn_addr1alice-${n}`,
      bob: `mn_addr1bob-${n}`,
      conv: `conv-${n}`,
      kp: (suffix: string) => `kp-${n}-${suffix}`,
    };
  };
  const bytes = (fill: number, len = 8): Uint8Array => new Uint8Array(len).fill(fill);

  it('re-uploading the same KeyPackage id is a no-op', async () => {
    const store = make();
    const { bob, kp } = ns();
    expect(await store.publishDmKeyPackages(bob, [{ id: kp('1'), keyPackage: bytes(1) }])).toBe(1);
    expect(await store.publishDmKeyPackages(bob, [{ id: kp('1'), keyPackage: bytes(1) }])).toBe(0);
    expect(await store.countDmKeyPackages(bob)).toBe(1);
  });

  it('never hands out the same KeyPackage twice', async () => {
    // MLS init keys are single-use; reissuing one would let two groups share entry material.
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [
      { id: kp('a'), keyPackage: bytes(0xa) },
      { id: kp('b'), keyPackage: bytes(0xb) },
    ]);
    const first = await store.claimDmKeyPackage(bob, alice);
    const second = await store.claimDmKeyPackage(bob, alice);
    expect(first?.id).toBeDefined();
    expect(second?.id).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
    expect(await store.countDmKeyPackages(bob)).toBe(0);
    // Pool empty: undefined, never a recycled package.
    expect(await store.claimDmKeyPackage(bob, alice)).toBeUndefined();
  });

  it('retires unclaimed packages, scoped to their owner', async () => {
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [
      { id: kp('keep'), keyPackage: bytes(1) },
      { id: kp('drop'), keyPackage: bytes(2) },
    ]);
    await store.publishDmKeyPackages(alice, [{ id: kp('alice'), keyPackage: bytes(3) }]);

    // Another subject's id, and one that was never published: neither may remove anything.
    expect(await store.retireDmKeyPackages(bob, [kp('alice'), kp('never')])).toBe(0);
    expect(await store.retireDmKeyPackages(bob, [kp('drop')])).toBe(1);

    expect(await store.countDmKeyPackages(bob)).toBe(1);
    expect(await store.countDmKeyPackages(alice)).toBe(1);
    expect((await store.claimDmKeyPackage(bob, alice))?.id).toBe(kp('keep'));
    // Idempotent — a retried retire after a dropped response is a no-op, not an error.
    expect(await store.retireDmKeyPackages(bob, [kp('drop')])).toBe(0);
  });

  // ⚠️ A claimed row is what stops a spent single-use init key being re-published and handed out a
  // second time. Retiring must never delete that tombstone.
  it('leaves a claimed package in place, so it can never be resurrected', async () => {
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [{ id: kp('spent'), keyPackage: bytes(4) }]);
    await store.claimDmKeyPackage(bob, alice);

    expect(await store.retireDmKeyPackages(bob, [kp('spent')])).toBe(0);
    expect(await store.publishDmKeyPackages(bob, [{ id: kp('spent'), keyPackage: bytes(4) }])).toBe(0);
    expect(await store.countDmKeyPackages(bob)).toBe(0);
  });

  it('claiming reports the pool empty rather than falling back to another subject', async () => {
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(alice, [{ id: kp('alice'), keyPackage: bytes(3) }]);
    expect(await store.claimDmKeyPackage(bob, alice)).toBeUndefined();
    expect(await store.countDmKeyPackages(alice)).toBe(1);
  });

  it('returns messages in order and preserves ciphertext bytes exactly', async () => {
    const store = make();
    const { alice, bob, conv } = ns();
    const m1 = `${conv}-m1`;
    const m2 = `${conv}-m2`;
    await store.appendDmMessage({ id: m1, convId: conv, sender: alice, recipient: bob, ciphertext: bytes(0x11) });
    await store.appendDmMessage({ id: m2, convId: conv, sender: bob, recipient: alice, ciphertext: bytes(0x22) });
    const messages = await store.listDmMessages(conv, alice);
    expect(messages.map((m) => m.id)).toEqual([m1, m2]);
    expect(Uint8Array.from(messages[0]!.ciphertext)).toEqual(bytes(0x11));
    expect(Uint8Array.from(messages[1]!.ciphertext)).toEqual(bytes(0x22));
  });

  it('the since cursor is exclusive, so polling does not re-deliver', async () => {
    const store = make();
    const { alice, bob, conv } = ns();
    const first = await store.appendDmMessage({
      id: `${conv}-p1`,
      convId: conv,
      sender: alice,
      recipient: bob,
      ciphertext: bytes(1),
    });
    await store.appendDmMessage({
      id: `${conv}-p2`,
      convId: conv,
      sender: alice,
      recipient: bob,
      ciphertext: bytes(2),
    });
    const after = await store.listDmMessages(conv, alice, first.createdAt);
    expect(after.map((m) => m.id)).not.toContain(`${conv}-p1`);
  });

  it('lists conversations for either party with the peer resolved', async () => {
    const store = make();
    const { alice, bob, conv } = ns();
    await store.appendDmMessage({ id: `${conv}-c1`, convId: conv, sender: alice, recipient: bob, ciphertext: bytes(1) });
    const forBob = await store.listDmConversations(bob);
    expect(forBob.find((c) => c.convId === conv)?.peer).toBe(alice);
    const forAlice = await store.listDmConversations(alice);
    expect(forAlice.find((c) => c.convId === conv)?.peer).toBe(bob);
    // A subject uninvolved in the conversation must not see it.
    expect((await store.listDmConversations(`${conv}-carol`)).map((c) => c.convId)).not.toContain(conv);
  });

  it('Welcomes are single-use: taken once, then gone', async () => {
    const store = make();
    const { alice, bob, conv } = ns();
    await store.putDmWelcome({
      id: `${conv}-w1`,
      convId: conv,
      sender: alice,
      recipient: bob,
      welcome: bytes(0x77),
      ratchetTree: bytes(0x88),
    });
    const listed = await store.listDmWelcomes(bob);
    expect(listed).toHaveLength(1);
    expect(Uint8Array.from(listed[0]!.welcome)).toEqual(bytes(0x77));
    expect(Uint8Array.from(listed[0]!.ratchetTree)).toEqual(bytes(0x88));

    // ⚠️ **Reading must not consume.** A Welcome is single-use and cannot be regenerated, so a
    // delete-on-read lost the invitation to anything that went wrong afterwards — a dropped
    // response, an app killed mid-drain, a join that threw, a private half that had gone missing.
    expect(await store.listDmWelcomes(bob)).toHaveLength(1);

    // Only the ack consumes it, and only for its own recipient.
    expect(await store.ackDmWelcomes(alice, [`${conv}-w1`])).toBe(0);
    expect(await store.listDmWelcomes(bob)).toHaveLength(1);
    expect(await store.ackDmWelcomes(bob, [`${conv}-w1`])).toBe(1);
    expect(await store.listDmWelcomes(bob)).toHaveLength(0);
    // Idempotent: a retried ack after a dropped response is a no-op, not an error.
    expect(await store.ackDmWelcomes(bob, [`${conv}-w1`])).toBe(0);
  });

  it('drops a delivered message only for the party that received it', async () => {
    const store = make();
    const { alice, bob, conv } = ns();
    const m1 = `${conv}-m1`;
    await store.appendDmMessage({ id: m1, convId: conv, sender: alice, recipient: bob, ciphertext: bytes(0x11) });

    // ⚠️ One row serves both parties. A sender acking its own outgoing message would delete it
    // before the other side had ever fetched it.
    expect(await store.ackDmMessages(alice, [m1])).toBe(0);
    expect(await store.listDmMessages(conv, alice)).toHaveLength(1);

    expect(await store.ackDmMessages(bob, [m1])).toBe(1);
    expect(await store.listDmMessages(conv, alice)).toHaveLength(0);
  });

  // A device that lost its private halves cannot name the ids — they went with them — while its
  // published pool still looks healthy to everyone else.
  it('retires a whole pool for a subject, sparing the claimed tombstones', async () => {
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [
      { id: kp('1'), keyPackage: bytes(1) },
      { id: kp('2'), keyPackage: bytes(2) },
      { id: kp('3'), keyPackage: bytes(3) },
    ]);
    await store.publishDmKeyPackages(alice, [{ id: kp('a'), keyPackage: bytes(9) }]);
    // Whichever one the claim took — asserting a particular id here would be asserting the claim
    // *order*, which this test is not about and which changed to newest-first on 2026-09-01.
    const claimed = await store.claimDmKeyPackage(bob, alice);
    expect(claimed).toBeDefined();

    expect(await store.retireAllDmKeyPackages(bob)).toBe(2);
    expect(await store.countDmKeyPackages(bob)).toBe(0);
    // Another subject's pool is untouched...
    expect(await store.countDmKeyPackages(alice)).toBe(1);
    // ...and the spent package still cannot be resurrected.
    expect(await store.publishDmKeyPackages(bob, [{ id: claimed?.id ?? '', keyPackage: bytes(1) }])).toBe(0);
  });
});

describe.each(backends)('ContentStore DM retention contract ($name)', ({ make }) => {
  let n = 0;
  const ns = (): {alice: string; bob: string; conv: string; kp: (s: string) => string} => {
    n += 1;
    return {
      alice: `mn_addr1ret-alice-${n}`,
      bob: `mn_addr1ret-bob-${n}`,
      conv: `conv-ret-${n}`,
      kp: (suffix: string) => `kp-ret-${n}-${suffix}`,
    };
  };
  const bytes = (fill: number, len = 8): Uint8Array => new Uint8Array(len).fill(fill);
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Rows are stamped by the store, so age is expressed by sweeping *as if* it were later rather than
  // by backdating a row the API gives no way to backdate.
  const asIf = (days: number) => Date.now() + days * DAY_MS;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 12));

  it('keeps undelivered content that is still inside its window', async () => {
    // The other direction of the same boundary: without this, a sweep that deleted everything
    // unconditionally would pass every deletion test below.
    const store = make();
    const { alice, bob, conv } = ns();
    await store.appendDmMessage({ id: `m-${conv}`, convId: conv, sender: alice, recipient: bob, ciphertext: bytes(1) });
    await store.putDmWelcome({
      id: `w-${conv}`,
      convId: conv,
      sender: alice,
      recipient: bob,
      welcome: bytes(2),
      ratchetTree: bytes(3),
    });

    const outcome = await store.sweepDmRetention(DM_RETENTION, Date.now());
    expect(outcome.messagesDeleted).toBe(0);
    expect(outcome.welcomesDeleted).toBe(0);
    expect(await store.listDmMessages(conv, alice)).toHaveLength(1);
    expect(await store.listDmWelcomes(bob)).toHaveLength(1);
  });

  it('replaces a welcome posted twice under the same id, rather than failing the second', async () => {
    // ⚠️ The regression this exists for. A Welcome's id is derived from the conversation id, and a
    // conversation id is derived from the two parties — so starting a conversation with the same
    // peer twice reuses the id. The in-memory store has always overwritten (`dmWelcomes.set`) while
    // D1 did a plain INSERT against `id TEXT PRIMARY KEY`: the second attempt threw, the route had
    // no answer, and the sender got a 500 they read as "can't reach". The contract passed the whole
    // time because only one of the two stores was ever exercised for it.
    const store = make();
    const { alice, bob, conv } = ns();
    await store.putDmWelcome({
      id: `w-${conv}`,
      convId: conv,
      sender: alice,
      recipient: bob,
      welcome: bytes(2),
      ratchetTree: bytes(3),
    });
    await store.putDmWelcome({
      id: `w-${conv}`,
      convId: conv,
      sender: alice,
      recipient: bob,
      welcome: bytes(4),
      ratchetTree: bytes(5),
    });

    const pending = await store.listDmWelcomes(bob);
    expect(pending).toHaveLength(1);
    // The *second* group's material, not the first: the recipient must join the group the sender
    // actually holds, and after a rebuild that is the later one.
    expect([...pending[0]!.welcome]).toEqual([...bytes(4)]);
    expect([...pending[0]!.ratchetTree]).toEqual([...bytes(5)]);
  });

  it('deletes an unacked welcome and message once nobody is coming back for them', async () => {
    const store = make();
    const { alice, bob, conv } = ns();
    await store.appendDmMessage({ id: `m-${conv}`, convId: conv, sender: alice, recipient: bob, ciphertext: bytes(1) });
    await store.putDmWelcome({
      id: `w-${conv}`,
      convId: conv,
      sender: alice,
      recipient: bob,
      welcome: bytes(2),
      ratchetTree: bytes(3),
    });

    const outcome = await store.sweepDmRetention(DM_RETENTION, asIf(31));
    expect(outcome.messagesDeleted).toBeGreaterThanOrEqual(1);
    expect(outcome.welcomesDeleted).toBeGreaterThanOrEqual(1);
    expect(await store.listDmMessages(conv, alice)).toHaveLength(0);
    expect(await store.listDmWelcomes(bob)).toHaveLength(0);
  });

  it('caps a pool by dropping the oldest surplus, which is the orphaned batch', async () => {
    // A reinstall leaves its old public halves published with the private ones gone, so the older
    // batch is exactly the one that must stop being handed out.
    const store = make();
    const { bob, kp } = ns();
    const policy = { ...DM_RETENTION, unclaimedPerSubject: 2 };
    await store.publishDmKeyPackages(bob, [
      { id: kp('old-1'), keyPackage: bytes(1) },
      { id: kp('old-2'), keyPackage: bytes(2) },
    ]);
    await tick();
    await store.publishDmKeyPackages(bob, [
      { id: kp('new-1'), keyPackage: bytes(3) },
      { id: kp('new-2'), keyPackage: bytes(4) },
    ]);

    const outcome = await store.sweepDmRetention(policy, Date.now());
    expect(outcome.unclaimedOverCap).toBe(2);
    expect(await store.countDmKeyPackages(bob)).toBe(2);
    // Gone means re-publishable; kept means the row is still there and the insert is ignored.
    expect(await store.publishDmKeyPackages(bob, [{ id: kp('old-1'), keyPackage: bytes(1) }])).toBe(1);
    expect(await store.publishDmKeyPackages(bob, [{ id: kp('new-1'), keyPackage: bytes(3) }])).toBe(0);
  });

  it('caps each subject separately', async () => {
    const store = make();
    const { alice, bob, kp } = ns();
    const policy = { ...DM_RETENTION, unclaimedPerSubject: 1 };
    await store.publishDmKeyPackages(bob, [
      { id: kp('b1'), keyPackage: bytes(1) },
      { id: kp('b2'), keyPackage: bytes(2) },
    ]);
    await store.publishDmKeyPackages(alice, [{ id: kp('a1'), keyPackage: bytes(3) }]);

    await store.sweepDmRetention(policy, Date.now());
    expect(await store.countDmKeyPackages(bob)).toBe(1);
    expect(await store.countDmKeyPackages(alice)).toBe(1);
  });

  it('claims the newest package, so an orphaned batch is not what a peer is handed', async () => {
    // The liveness half of the retention work: FIFO handed out the oldest unclaimed row, which after a
    // reinstall is exactly the one whose private half is gone — a Welcome sealed to it can never be
    // opened, and the invite dies silently on the *claimer's* side.
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [{ id: kp('orphan'), keyPackage: bytes(1) }]);
    await tick();
    await store.publishDmKeyPackages(bob, [{ id: kp('live'), keyPackage: bytes(2) }]);

    const claimed = await store.claimDmKeyPackage(bob, alice);
    expect(claimed?.id).toBe(kp('live'));
  });

  it('never counts or deletes a claimed package under the cap', async () => {
    // A claimed row is a tombstone, not pool capacity; counting it would let the cap evict live
    // packages on behalf of ones already spent.
    const store = make();
    const { alice, bob, kp } = ns();
    const policy = { ...DM_RETENTION, unclaimedPerSubject: 1 };
    await store.publishDmKeyPackages(bob, [
      { id: kp('c1'), keyPackage: bytes(1) },
      { id: kp('c2'), keyPackage: bytes(2) },
    ]);
    await store.claimDmKeyPackage(bob, alice);

    const outcome = await store.sweepDmRetention(policy, Date.now());
    expect(outcome.unclaimedOverCap).toBe(0);
    expect(await store.countDmKeyPackages(bob)).toBe(1);
  });

  it('expires an unclaimed package that stayed under the cap', async () => {
    const store = make();
    const { bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [{ id: kp('dormant'), keyPackage: bytes(1) }]);

    const outcome = await store.sweepDmRetention(DM_RETENTION, asIf(91));
    expect(outcome.unclaimedExpired).toBeGreaterThanOrEqual(1);
    expect(await store.countDmKeyPackages(bob)).toBe(0);
  });

  it('empties a claimed tombstone without letting the spent package come back', async () => {
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [{ id: kp('spent'), keyPackage: bytes(1) }]);
    await store.claimDmKeyPackage(bob, alice);

    // Eight days: past the tombstone window, well inside every other one, so this isolates the rule.
    const outcome = await store.sweepDmRetention(DM_RETENTION, asIf(8));
    expect(outcome.tombstonesBlanked).toBeGreaterThanOrEqual(1);
    // The row is what stops a single-use init key being resurrected, and it must survive losing its bytes.
    expect(await store.publishDmKeyPackages(bob, [{ id: kp('spent'), keyPackage: bytes(1) }])).toBe(0);
  });

  it('reports nothing on a second pass over the same rows', async () => {
    // Idempotency, and specifically that blanking counts what it changed rather than what it matched:
    // a sweep re-reporting the same tombstones every run would read as permanent churn.
    const store = make();
    const { alice, bob, kp } = ns();
    await store.publishDmKeyPackages(bob, [{ id: kp('once'), keyPackage: bytes(1) }]);
    await store.claimDmKeyPackage(bob, alice);

    const first = await store.sweepDmRetention(DM_RETENTION, asIf(8));
    expect(first.tombstonesBlanked).toBeGreaterThanOrEqual(1);
    const second = await store.sweepDmRetention(DM_RETENTION, asIf(8));
    expect(second.tombstonesBlanked).toBe(0);
  });
});
