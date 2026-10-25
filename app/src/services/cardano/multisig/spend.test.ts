import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {describe, expect, it} from 'vitest'
import {addSignature, constructEnvelope} from '../cosign/envelope'
import type {TxEnvelope} from '../cosign/types'
import {envelopeMeetsPolicy, signersFor, validityFor} from './spend'
import {flatTemplate, type ScriptTemplate, tagAt, withTimeLock} from './template'
import type {SharedWallet} from './types'

const TAGS = [tagAt(0), tagAt(1), tagAt(2)]

const wallet = (template?: ScriptTemplate): SharedWallet => {
  const t = template ?? flatTemplate({kind: 'atLeast', n: 2}, TAGS)
  return {
    id: 'w1',
    name: 'Treasury',
    coSigners: TAGS.map((tag, i) => ({
      tag,
      name: `C${i}`,
      accountXpubHex: XpubHex(`${i}${i}`.repeat(64).slice(0, 128)),
    })),
    paymentTemplate: t,
    delegationTemplate: t,
    network: Address.Network.Testnet,
    accountIndex: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
  }
}

const hashes = new Map(TAGS.map((tag, i) => [tag, `${i}${i}`.repeat(28).slice(0, 56)]))

describe('validityFor', () => {
  it('is unbounded for a plain template', () => {
    expect(validityFor(wallet())).toEqual({invalidBefore: null, invalidHereafter: null})
  })

  it('carries the template bounds so the tx passes phase-1', () => {
    // A time-locked script fails validation if the transaction omits the
    // interval, whenever it is submitted.
    const locked = withTimeLock(flatTemplate({kind: 'all'}, TAGS), {from: 100n, until: 900n})
    expect(validityFor(wallet(locked))).toEqual({invalidBefore: 100n, invalidHereafter: 900n})
  })
})

describe('signersFor', () => {
  it('lists every co-signer unsigned, with its derived key hash', () => {
    const signers = signersFor(wallet(), hashes)
    expect(signers).toHaveLength(3)
    expect(signers.every((s) => !s.signed)).toBe(true)
    expect(signers[0]?.keyHashHex).toBe(hashes.get(tagAt(0)))
  })

  it('marks the self co-signer', () => {
    const w = wallet()
    const withSelf: SharedWallet = {
      ...w,
      coSigners: w.coSigners.map((c, i) => (i === 1 ? {...c, isSelf: true} : c)),
    }
    expect(signersFor(withSelf, hashes)[1]?.isSelf).toBe(true)
  })
})

describe('envelopeMeetsPolicy', () => {
  const witness = (tag: string) => ({
    vkeyHex: `vk-${tag}`,
    sigHex: `sig-${tag}`,
    keyHashHex: hashes.get(tag) ?? '',
  })

  const envelopeOf = (template?: ScriptTemplate): {readonly w: SharedWallet; readonly envelope: TxEnvelope} => {
    const w = wallet(template)
    return {
      w,
      envelope: constructEnvelope({
        kind: 'multisig',
        bodyHex: 'a1',
        nativeScriptHexes: ['8201'],
        chainId: 'cardano:preprod',
        createdBy: 'T',
        createdAt: '2026-08-08T00:00:00.000Z',
        accountIndex: 0,
        keyIndex: 0,
        signers: signersFor(w, hashes),
      }),
    }
  }

  it('is unmet below the threshold and met at it', () => {
    const {w, envelope} = envelopeOf()
    expect(envelopeMeetsPolicy(w, addSignature(envelope, witness(tagAt(0))))).toBe(false)
    const two = addSignature(addSignature(envelope, witness(tagAt(0))), witness(tagAt(1)))
    expect(envelopeMeetsPolicy(w, two)).toBe(true)
  })

  it('judges a nested policy structurally rather than by count', () => {
    // The reason this function is kept even though the live gate counts: a count
    // cannot tell these two pairs apart, and one of them does not satisfy the
    // script. Reachable only via an imported nested template today — the roster
    // editor builds flat ones — which is why the count rule ships.
    const nested: ScriptTemplate = {
      kind: 'all',
      scripts: [
        {kind: 'cosigner', tag: tagAt(0)},
        {
          kind: 'any',
          scripts: [
            {kind: 'cosigner', tag: tagAt(1)},
            {kind: 'cosigner', tag: tagAt(2)},
          ],
        },
      ],
    }
    const {w, envelope} = envelopeOf(nested)
    const wrongTwo = addSignature(addSignature(envelope, witness(tagAt(1))), witness(tagAt(2)))
    expect(envelopeMeetsPolicy(w, wrongTwo)).toBe(false)
    const rightTwo = addSignature(addSignature(envelope, witness(tagAt(0))), witness(tagAt(2)))
    expect(envelopeMeetsPolicy(w, rightTwo)).toBe(true)
  })
})
