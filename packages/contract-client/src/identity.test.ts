import {ed25519} from '@noble/curves/ed25519.js'
import {describe, expect, it} from 'vitest'
import {personaCommitment} from './circle-derivations'
import {identityCommitment} from './derivations'
import {
  authChallengeMessage,
  authKeyPair,
  decodePnyxId,
  deviceBindingMessage,
  encodePnyxId,
  identityCommitmentOf,
  identitySkFromForumRoot,
  pnyxIdEquals,
} from './identity'
import {forumRoot} from './persona'

const seed = Uint8Array.from({length: 32}, (_, i) => i + 1)
const root = forumRoot(seed)
const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)

describe('identitySkFromForumRoot', () => {
  it('is deterministic', () => {
    expect(identitySkFromForumRoot(root)).toEqual(identitySkFromForumRoot(root))
  })

  // Same argument as personas: the contract is deployed per network, so an identity producing
  // identical commitments on preprod and mainnet would let an observer link a test identity to a
  // real one by comparing the two chains.
  // `C` is a public identifier, so scoping it per network bought no privacy and cost the whole
  // preprod→mainnet migration: every identity, avatar and DM anchor would have been reset. Pinned
  // as arity, because a network parameter reappearing here is the regression.
  it('takes the forum root and nothing else', () => {
    expect(identitySkFromForumRoot.length).toBe(1)
  })

  it('differs per seed', () => {
    const other = forumRoot(new Uint8Array(32).fill(9))
    expect(identitySkFromForumRoot(root)).not.toEqual(identitySkFromForumRoot(other))
  })
})

describe('identityCommitmentOf', () => {
  // The app runs on Hermes and cannot load compact-runtime, so it recomputes the commitment with
  // plain SHA-256. If these two ever diverge the app would key rows the circuit can never write.
  it('matches the compact-runtime derivation exactly', () => {
    for (const fill of [0, 1, 0x2a, 0xff]) {
      const sk = new Uint8Array(32).fill(fill)
      expect(identityCommitmentOf(sk)).toEqual(identityCommitment(sk))
    }
    expect(identityCommitmentOf(identitySkFromForumRoot(root))).toEqual(
      identityCommitment(identitySkFromForumRoot(root)),
    )
  })

  it('rejects a secret that is not 32 bytes', () => {
    expect(() => identityCommitmentOf(new Uint8Array(31))).toThrow(/32 bytes/)
  })
})

describe('domain separation', () => {
  // The account identity and a persona must never collide even when fed the same secret, or the
  // account would be linkable to a circle persona derived from the same seed.
  it('never collides with a persona commitment for the same secret', () => {
    const sk = identitySkFromForumRoot(root)
    expect(identityCommitment(sk)).not.toEqual(personaCommitment(sk))
  })
})

describe('pnyx_id encoding', () => {
  const identity = bytes32(0x2a)

  it('round-trips', () => {
    expect(decodePnyxId(encodePnyxId(identity)).identity).toEqual(identity)
  })

  // An id names a person, not a chain. There is one HRP and it never varies, so the same id shared
  // from any deployment decodes here — whether that person has a row on *this* network is a lookup,
  // and its absence is "not registered here yet" rather than a decode failure.
  it('carries no network, on any deployment', () => {
    expect(encodePnyxId(identity).startsWith('pnyx_id1')).toBe(true)
    expect(encodePnyxId(identity)).not.toContain('_preprod')
    expect(encodePnyxId(identity)).not.toContain('_undeployed')
  })

  it('rejects a corrupted id rather than decoding it', () => {
    const encoded = encodePnyxId(identity)
    const corrupted = `${encoded.slice(0, -1)}${encoded.endsWith('q') ? 'p' : 'q'}`
    expect(() => decodePnyxId(corrupted)).toThrow()
  })

  it('rejects a foreign HRP', () => {
    expect(() => decodePnyxId('mn_addr1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toThrow()
  })

  it('rejects a payload that is not 32 bytes', () => {
    expect(() => encodePnyxId(new Uint8Array(31))).toThrow(/32 bytes/)
  })
})

describe('pnyxIdEquals', () => {
  it('compares by decoded bytes, not by string', () => {
    const a = encodePnyxId(bytes32(3))
    expect(pnyxIdEquals(a, encodePnyxId(bytes32(3)))).toBe(true)
    expect(pnyxIdEquals(a, encodePnyxId(bytes32(4)))).toBe(false)
  })

  // bech32m is case-insensitive by design, so the uppercase form is the same identity. Seeding an
  // avatar on the text rather than the bytes would draw these two different faces.
  it('treats the uppercase form as the same identity', () => {
    const a = encodePnyxId(bytes32(3))
    expect(pnyxIdEquals(a, a.toUpperCase())).toBe(true)
  })
})

describe('auth keypair', () => {
  const sk = identitySkFromForumRoot(root)

  it('is deterministic and verifies its own challenge', () => {
    const pair = authKeyPair(sk)
    expect(authKeyPair(sk).publicKey).toEqual(pair.publicKey)
    const msg = authChallengeMessage('pnyx.test', 'mainnet', 'pnyx_id1abc', 'nonce-1')
    expect(ed25519.verify(ed25519.sign(msg, pair.secretKey), msg, pair.publicKey)).toBe(true)
  })

  // The auth key must not be the identity secret: publishing authPub would otherwise publish the
  // ability to write the row.
  it('is not the identity secret itself', () => {
    expect(authKeyPair(sk).secretKey).not.toEqual(sk)
  })

  // Domain and network are inside the signed bytes, so a challenge answered on preprod cannot be
  // replayed against mainnet.
  it('binds domain, network, identity and nonce', () => {
    const base = authChallengeMessage('a.test', 'mainnet', 'id1', 'n1')
    for (const other of [
      authChallengeMessage('b.test', 'mainnet', 'id1', 'n1'),
      authChallengeMessage('a.test', 'preprod', 'id1', 'n1'),
      authChallengeMessage('a.test', 'mainnet', 'id2', 'n1'),
      authChallengeMessage('a.test', 'mainnet', 'id1', 'n2'),
    ]) {
      expect(other).not.toEqual(base)
    }
  })
})

describe('deviceBindingMessage', () => {
  // The whole point of a distinct domain tag: a push binding signed for an identity must not be
  // presentable as that identity's login, nor the reverse. Same key, same curve — only the bytes
  // differ, so if the tags ever collided one signature would authorise both.
  it('cannot collide with a login challenge', () => {
    const login = authChallengeMessage('a.test', 'mainnet', 'id1', 'n1')
    const binding = deviceBindingMessage('a.test', 'mainnet', 'id1', 'n1', 'tok', 'android')
    expect(binding).not.toEqual(login)
    expect(new TextDecoder().decode(binding).startsWith('pnyx:fcm|')).toBe(true)
  })

  it('binds every field', () => {
    const base = deviceBindingMessage('a.test', 'mainnet', 'id1', 'n1', 'tok', 'android')
    for (const other of [
      deviceBindingMessage('b.test', 'mainnet', 'id1', 'n1', 'tok', 'android'),
      deviceBindingMessage('a.test', 'preprod', 'id1', 'n1', 'tok', 'android'),
      deviceBindingMessage('a.test', 'mainnet', 'id2', 'n1', 'tok', 'android'),
      deviceBindingMessage('a.test', 'mainnet', 'id1', 'n2', 'tok', 'android'),
      deviceBindingMessage('a.test', 'mainnet', 'id1', 'n1', 'tok2', 'android'),
      deviceBindingMessage('a.test', 'mainnet', 'id1', 'n1', 'tok', 'ios'),
    ]) {
      expect(other).not.toEqual(base)
    }
  })

  // Regression: the token used to enter the `|`-delimited message verbatim, so shifting a delimiter
  // between the two variable-length tail fields produced identical bytes — one signature authorising
  // a binding for a different token. The fixed-length digest is what makes the split unambiguous.
  it('does not let a delimiter shift between token and platform collide', () => {
    expect(deviceBindingMessage('a.test', 'mainnet', 'id1', 'n1', 'a|android', 'x')).not.toEqual(
      deviceBindingMessage('a.test', 'mainnet', 'id1', 'n1', 'a', 'android|x'),
    )
  })
})
