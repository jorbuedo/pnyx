import {AddressHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {inviteRewardAddress, inviteSigningRequest, utf8ToHex} from './circle-invite-review'

/** Arbitrary but fixed 28-byte credentials — the values are irrelevant, their reuse is the point. */
const PAYMENT_HASH = '00'.repeat(28)
const STAKE_HASH = '11'.repeat(28)
const SCRIPT_HASH = '22'.repeat(28)

const bech32 = (addrHex: string) => Effect.runPromise(Address.toBech32(AddressHex(addrHex)))

describe('inviteRewardAddress', () => {
  it('builds a mainnet reward address from a mainnet base address', async () => {
    const base = await bech32(Address.baseHex(Address.Network.Mainnet, PAYMENT_HASH, STAKE_HASH))

    const reward = await inviteRewardAddress(base)

    expect(reward.rewardHex).toBe(`e1${STAKE_HASH}`)
    expect(reward.rewardBech32.startsWith('stake1')).toBe(true)
  })

  it('builds a MAINNET reward address from a TESTNET base address', async () => {
    // The bug this pins: the credential is network-independent, but building the reward address for
    // whatever network the app was on asked mainnet Koios about a `stake_test1…` address, which
    // answers 500 — so every gated join came back as a retryable outage.
    const testnetBase = await bech32(Address.baseHex(Address.Network.Testnet, PAYMENT_HASH, STAKE_HASH))
    const mainnetBase = await bech32(Address.baseHex(Address.Network.Mainnet, PAYMENT_HASH, STAKE_HASH))

    const fromTestnet = await inviteRewardAddress(testnetBase)
    const fromMainnet = await inviteRewardAddress(mainnetBase)

    expect(fromTestnet.rewardHex).toBe(fromMainnet.rewardHex)
    expect(fromTestnet.rewardBech32).toBe(fromMainnet.rewardBech32)
    expect(fromTestnet.rewardBech32.startsWith('stake_test1')).toBe(false)
  })

  it('refuses an address with no stake credential', async () => {
    const enterprise = await bech32(Address.enterpriseHex(Address.Network.Mainnet, PAYMENT_HASH))

    await expect(inviteRewardAddress(enterprise)).rejects.toThrow(/no stake credential/)
  })

  it('refuses a script stake credential, which no single signer controls', async () => {
    const scripted = await bech32(Address.baseScriptScriptHex(Address.Network.Mainnet, SCRIPT_HASH, SCRIPT_HASH))

    await expect(inviteRewardAddress(scripted)).rejects.toThrow(/script/)
  })
})

describe('inviteSigningRequest', () => {
  const reward = `e1${STAKE_HASH}`

  it('signs with the stake key of the CHOSEN account, not account 0', () => {
    // A fixed `CARDANO_STAKE_PATH` would derive account 0's key, whose hash does not match the
    // address — which `softwareSignData` refuses outright rather than signing a wrong assertion.
    const request = inviteSigningRequest({groupId: 'g1', accountIndex: 3, rewardHex: reward, payload: 'hello'})

    expect(request.payload.signingPath).toBe("m/1852'/1815'/3'/2/0")
    expect(request.accountIndex).toBe(3)
  })

  it('asserts the reward address and carries the challenge as UTF-8 bytes', () => {
    const request = inviteSigningRequest({groupId: 'g1', accountIndex: 0, rewardHex: reward, payload: 'pnyx:inv:1'})

    expect(request.payload._tag).toBe('CardanoData')
    expect(request.payload.addressHex).toBe(reward)
    expect(request.payload.payloadHex).toBe(utf8ToHex('pnyx:inv:1'))
    expect(request.groupId).toBe('g1')
  })

  it('names Cardano mainnet whatever network the app is on', () => {
    const request = inviteSigningRequest({groupId: 'g1', accountIndex: 0, rewardHex: reward, payload: 'x'})

    expect(request.payload.networkId).toBe(Address.Network.Mainnet)
  })

  it('encodes multi-byte characters as their UTF-8 bytes', () => {
    expect(utf8ToHex('é')).toBe('c3a9')
  })
})
