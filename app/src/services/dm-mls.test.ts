import {hkdfSha256} from '@pnyx/crypto'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  addDmMember,
  createDmGroup,
  decodeDmKeyPackageRecord,
  decodeDmState,
  deriveMlsIdentity,
  dmCiphersuite,
  dmEpochOf,
  dmFrameInfo,
  dmGroupIdOf,
  encodeDmKeyPackageRecord,
  encodeDmState,
  joinDmGroup,
  makeDmKeyPackage,
  newDmGroupId,
  openDmMessage,
  sealDmMessage,
  verifyKeyPackageAnchor,
} from './dm-mls'

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e as Effect.Effect<A, never>)

const ADDR_A = 'mn_addr1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqalice'
const ADDR_B = 'mn_addr1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqbob'

const forumRoot = (byte: number): Uint8Array => new Uint8Array(32).fill(byte)

/** Two members in one group, ready to exchange application messages. */
const twoMemberGroup = async () => {
  const cs = await run(dmCiphersuite())
  const idA = await run(deriveMlsIdentity(forumRoot(1)))
  const idB = await run(deriveMlsIdentity(forumRoot(2)))
  const kpA = await run(makeDmKeyPackage(idA, ADDR_A, cs))
  const kpB = await run(makeDmKeyPackage(idB, ADDR_B, cs))

  const created = await run(createDmGroup(await run(newDmGroupId()), kpA, cs))
  const invite = await run(addDmMember(created, kpB.publicPackage, cs))
  const stateB = await run(joinDmGroup(invite.welcome, kpB, invite.ratchetTree, cs))
  return {cs, idA, idB, kpA, kpB, stateA: invite.state, stateB}
}

describe('group identity', () => {
  it('gives two groups for the same pair different ids', async () => {
    // ⚠️ The property the wire break exists for. This used to be `utf8(conversationId)`, so every
    // group ever built for a pair carried the same id — two devices could sit in different groups
    // and nothing on the wire distinguished them. RFC 9420 asks for a freshly generated random
    // value precisely so honest creators never collide.
    const first = await run(newDmGroupId())
    const second = await run(newDmGroupId())
    expect(first).toHaveLength(32)
    expect([...first]).not.toEqual([...second])
  })

  it('reads the group and epoch off a message without opening it', async () => {
    // MLS keeps group_id and epoch outside the encryption so a message can be routed before it is
    // decrypted. That is what turns "we have diverged" into a fact rather than an inference from a
    // failed decrypt, which cannot tell a wrong group from a corrupt ciphertext.
    const {cs, stateA} = await twoMemberGroup()
    const sent = await run(sealDmMessage(stateA, new TextEncoder().encode('hello'), cs))

    const frame = dmFrameInfo(sent.message)

    if (frame === undefined) throw new Error('a sealed application message must decode as a private message')
    expect([...frame.groupId]).toEqual([...dmGroupIdOf(stateA)])
    expect(frame.epoch).toBe(dmEpochOf(stateA))
  })

  it('shows a message from another group as another group, before any key is tried', async () => {
    // The exact shape of the bug: two groups, same conversation, and the reader must be able to say
    // so. Under the old scheme both sides reported the identical id and this assertion was
    // impossible to write.
    const one = await twoMemberGroup()
    const other = await twoMemberGroup()
    const sent = await run(sealDmMessage(other.stateA, new TextEncoder().encode('from elsewhere'), one.cs))

    const frame = dmFrameInfo(sent.message)

    if (frame === undefined) throw new Error('a sealed application message must decode as a private message')
    expect([...frame.groupId]).not.toEqual([...dmGroupIdOf(one.stateA)])
  })
})

describe('deriveMlsIdentity', () => {
  it('is deterministic for the same forumRoot', async () => {
    const a = await run(deriveMlsIdentity(forumRoot(7)))
    const b = await run(deriveMlsIdentity(forumRoot(7)))
    expect(a.signKey).toEqual(b.signKey)
    expect(a.publicKey).toEqual(b.publicKey)
    expect(a.publicKey).toHaveLength(32)
  })

  // This key is the `anchor` a peer checks a KeyPackage against, so scoping it per network would
  // break every DM at the preprod→mainnet migration. There is no network to vary now; what is
  // checkable is that one cannot be reintroduced.
  it('takes no network, so the anchor survives a migration', async () => {
    expect(deriveMlsIdentity.length).toBe(1)
    const a = await run(deriveMlsIdentity(forumRoot(7)))
    const b = await run(deriveMlsIdentity(forumRoot(8)))
    expect(a.signKey).not.toEqual(b.signKey)
  })

  it('is not the phase-1 X25519 DM key derived from the same root', async () => {
    // Reusing one key for signing and key agreement is the hazard this separation exists to avoid.
    const mls = await run(deriveMlsIdentity(forumRoot(7)))
    const dm = await run(hkdfSha256(forumRoot(7), new TextEncoder().encode('pnyx:dm:v1:mainnet'), 32))
    expect(mls.signKey).not.toEqual(dm)
  })
})

describe('MLS round trip', () => {
  it('carries a message from the creator to the invitee', async () => {
    const {cs, stateA, stateB} = await twoMemberGroup()
    const sent = await run(sealDmMessage(stateA, new TextEncoder().encode('hello bob'), cs))
    const got = await run(openDmMessage(stateB, sent.message, cs))
    expect(got.plaintext).toBeDefined()
    expect(new TextDecoder().decode(got.plaintext)).toBe('hello bob')
  })

  it('carries a message back from the invitee to the creator', async () => {
    const {cs, stateA, stateB} = await twoMemberGroup()
    const sent = await run(sealDmMessage(stateB, new TextEncoder().encode('hi alice'), cs))
    const got = await run(openDmMessage(stateA, sent.message, cs))
    expect(new TextDecoder().decode(got.plaintext)).toBe('hi alice')
  })

  it('produces a different ciphertext for the same plaintext twice (the ratchet advanced)', async () => {
    const {cs, stateA} = await twoMemberGroup()
    const plaintext = new TextEncoder().encode('same text')
    const first = await run(sealDmMessage(stateA, plaintext, cs))
    const second = await run(sealDmMessage(first.state, plaintext, cs))
    expect(first.message).not.toEqual(second.message)
  })

  it('rejects a tampered ciphertext', async () => {
    const {cs, stateA, stateB} = await twoMemberGroup()
    const sent = await run(sealDmMessage(stateA, new TextEncoder().encode('hello'), cs))
    const tampered = Uint8Array.from(sent.message)
    const last = tampered.length - 1
    tampered.set([(tampered[last] as number) ^ 0xff], last)
    const result = await Effect.runPromise(Effect.either(openDmMessage(stateB, tampered, cs)))
    expect(result._tag).toBe('Left')
  })

  it('rejects a message replayed into an unrelated group', async () => {
    const {cs, stateA} = await twoMemberGroup()
    const other = await twoMemberGroup()
    const sent = await run(sealDmMessage(stateA, new TextEncoder().encode('secret'), cs))
    const result = await Effect.runPromise(Effect.either(openDmMessage(other.stateB, sent.message, cs)))
    expect(result._tag).toBe('Left')
  })

  // The sender cannot open its own application message — sealing consumed that generation. This is
  // load-bearing for the thread screen: `/dm/:id/messages` returns our own frames alongside the
  // peer's, so `drain` must skip anything we sent instead of trying to open it. Without the skip
  // every sent message reappears as an "undecryptable" bubble attributed to the peer.
  it('does not let a sender open its own message', async () => {
    const {cs} = await twoMemberGroup()
    const {stateA} = await twoMemberGroup()
    const sent = await run(sealDmMessage(stateA, new TextEncoder().encode('mine'), cs))
    const result = await Effect.runPromise(Effect.either(openDmMessage(sent.state, sent.message, cs)))
    expect(result._tag).toBe('Left')
  })
})

describe('verifyKeyPackageAnchor', () => {
  it('accepts a package whose leaf key is the row anchor and whose credential is the identity', async () => {
    const {idB, kpB} = await twoMemberGroup()
    expect(verifyKeyPackageAnchor(kpB.publicPackage, idB.publicKey, ADDR_B)).toBe(true)
  })

  it('rejects a package presented under the wrong address', async () => {
    // The forgery phase 1 could not detect: a valid package re-attributed to another identity.
    const {idB, kpB} = await twoMemberGroup()
    expect(verifyKeyPackageAnchor(kpB.publicPackage, idB.publicKey, ADDR_A)).toBe(false)
  })

  it('rejects a package that does not match the anchor', async () => {
    const {idA, kpB} = await twoMemberGroup()
    expect(verifyKeyPackageAnchor(kpB.publicPackage, idA.publicKey, ADDR_B)).toBe(false)
  })
})

describe('state persistence', () => {
  it('survives an encode/decode cycle and can still decrypt', async () => {
    const {cs, stateA, stateB} = await twoMemberGroup()
    const restoredB = await run(decodeDmState(encodeDmState(stateB)))
    const sent = await run(sealDmMessage(stateA, new TextEncoder().encode('after restart'), cs))
    const got = await run(openDmMessage(restoredB, sent.message, cs))
    expect(new TextDecoder().decode(got.plaintext)).toBe('after restart')
  })

  it('fails on undecodable bytes rather than returning a broken state', async () => {
    const result = await Effect.runPromise(Effect.either(decodeDmState(new Uint8Array([1, 2, 3]))))
    expect(result._tag).toBe('Left')
  })
})

describe('KeyPackage record codec', () => {
  it('round-trips both halves, so an arriving Welcome can be joined', async () => {
    // Both halves are required: joinGroup needs the public package and a Welcome does not carry it
    // back, so storing only the private half yields a package that can never be joined.
    const {cs, kpB} = await twoMemberGroup()
    const restored = await run(decodeDmKeyPackageRecord(encodeDmKeyPackageRecord(kpB)))
    expect(restored.publicPackage.leafNode.signaturePublicKey).toEqual(kpB.publicPackage.leafNode.signaturePublicKey)
    expect(restored.privatePackage.initPrivateKey).toEqual(kpB.privatePackage.initPrivateKey)
    expect(restored.privatePackage.hpkePrivateKey).toEqual(kpB.privatePackage.hpkePrivateKey)
    expect(restored.privatePackage.signaturePrivateKey).toEqual(kpB.privatePackage.signaturePrivateKey)
    expect(cs.name).toBeDefined()
  })

  it('a restored record can actually join the group it was invited to', async () => {
    // The end-to-end version of the above: the record survives storage and still opens a Welcome.
    const cs = await run(dmCiphersuite())
    const idA = await run(deriveMlsIdentity(forumRoot(21)))
    const idB = await run(deriveMlsIdentity(forumRoot(22)))
    const kpA = await run(makeDmKeyPackage(idA, ADDR_A, cs))
    const kpB = await run(makeDmKeyPackage(idB, ADDR_B, cs))
    const stored = encodeDmKeyPackageRecord(kpB)

    const created = await run(createDmGroup(await run(newDmGroupId()), kpA, cs))
    const invite = await run(addDmMember(created, kpB.publicPackage, cs))

    const restored = await run(decodeDmKeyPackageRecord(stored))
    const stateB = await run(joinDmGroup(invite.welcome, restored, invite.ratchetTree, cs))
    const sent = await run(sealDmMessage(invite.state, new TextEncoder().encode('joined from storage'), cs))
    const got = await run(openDmMessage(stateB, sent.message, cs))
    expect(new TextDecoder().decode(got.plaintext)).toBe('joined from storage')
  })

  it('rejects a record with the wrong field count instead of mis-slicing', async () => {
    const short = new Uint8Array([0, 1, 0xaa])
    expect((await Effect.runPromise(Effect.either(decodeDmKeyPackageRecord(short))))._tag).toBe('Left')
  })
})
