import {decodePnyxId, encodePnyxId, identityCommitmentOf, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {forumRoot} from '@pnyx/contract-client/persona'
import {mnemonicToSeed} from '@pnyx/wallet'
import {validateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {describe, expect, it} from 'vitest'
import {discardCandidates, generateIdentityCandidates, mnemonicForCandidate} from './identity-candidates'

describe('generateIdentityCandidates', () => {
  it('produces distinct, well-formed identities', async () => {
    const candidates = await generateIdentityCandidates(5)
    expect(candidates).toHaveLength(5)
    expect(new Set(candidates.map((c) => c.pnyxId)).size).toBe(5)
    for (const candidate of candidates) {
      expect(candidate.entropy).toHaveLength(32)
      expect(decodePnyxId(candidate.pnyxId).identity).toHaveLength(32)
    }
  })

  // The gallery shows an avatar derived from `pnyxId`, and the user gets the wallet behind it.
  // If the retained entropy did not lead back to that same identity, the avatar someone picked
  // would not be the avatar they end up with — silently.
  it('entropy leads back to the identity whose avatar was shown', async () => {
    const [candidate] = await generateIdentityCandidates(1)
    if (candidate === undefined) throw new Error('no candidate')

    const mnemonic = mnemonicForCandidate(candidate)
    expect(validateMnemonic(mnemonic, wordlist)).toBe(true)

    const seed = await mnemonicToSeed(mnemonic)
    const root = forumRoot(seed)
    const derived = encodePnyxId(identityCommitmentOf(identitySkFromForumRoot(root)))
    expect(derived).toBe(candidate.pnyxId)
  })

  // 256-bit entropy is what Quick start has always used, so a picked identity is a 24-word phrase
  // like any other — not a weaker one because it came from a grid.
  it('yields a 24-word phrase', async () => {
    const [candidate] = await generateIdentityCandidates(1)
    if (candidate === undefined) throw new Error('no candidate')
    expect(mnemonicForCandidate(candidate).split(' ')).toHaveLength(24)
  })

  // The screen asks the user to *choose a face*, so that face has to be the one they keep. It used
  // to be network-scoped, which meant the preprod→mainnet migration silently handed every user a
  // different avatar than the one they picked. There is no network to vary any more, so what is
  // checkable is that none can be introduced: the generator takes only a count, and the ids it
  // produces carry the bare HRP rather than a per-network one.
  it('cannot be pointed at a network', async () => {
    expect(generateIdentityCandidates.length).toBe(1)
    const [candidate] = await generateIdentityCandidates(1)
    if (candidate === undefined) throw new Error('no candidate')
    expect(candidate.pnyxId.startsWith('pnyx_id1')).toBe(true)
  })
})

describe('discardCandidates', () => {
  // Not cosmetic: every unchosen tile is a live wallet. Zeroing the entropy is the only part of a
  // candidate we *can* clear, so it has to actually happen.
  it('zeroes the entropy of candidates the user did not pick', async () => {
    const candidates = await generateIdentityCandidates(3)
    discardCandidates(candidates)
    for (const candidate of candidates) {
      expect(candidate.entropy.every((b) => b === 0)).toBe(true)
    }
  })
})
