import {Address as EvolutionAddress, Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Address} from '@pnyx/cardano-core'
import {Effect, Exit, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {
  filterKeyCredentialAddresses,
  keepOwnedAccountUtxos,
  ReadOnlyImportError,
  resolveReadOnlyCardano,
} from './read-only'

const PAY = '11'.repeat(28)
const PAY2 = 'aa'.repeat(28)
const STAKE = '22'.repeat(28)
const SCRIPT = '33'.repeat(28)

// Deterministic, offline bech32 fixtures — synthesized from cred hashes through the real address
// tier (no network, no live Koios).
let baseKeyKey: string // addr1q… — key payment + key stake (KEPT)
let baseKeyKey2: string
let baseScriptKey: string // addr1z… — script payment + key stake (DROPPED)
let enterprise: string // addr1v… — no stake credential
let reward: string // stake1… — the account's reward address
let testnetBase: string // addr_test1… — wrong network

/** ⚠️ The provider alone. `resolveReadOnlyCardano` used to require a `Codec` too. */
const run = <A, E>(eff: Effect.Effect<A, E, EvolutionProvider.ProviderEffect>, addrs: readonly string[] = []) =>
  Effect.runPromiseExit(
    eff.pipe(
      Effect.provide(
        // ⚠️ The stub answers DECODED addresses, because that is what the typed read returns.
        // Handing back bech32 strings here would make the test pass over a shape no provider
        // produces, which is what the previous `as unknown as` cast allowed.
        Layer.succeed(EvolutionProvider.ProviderEffect, {
          getAccountAddresses: (_stake: string, _opts?: {readonly offset?: number}) =>
            Effect.succeed(addrs.map((a) => EvolutionAddress.fromBech32(a))),
        } as unknown as EvolutionProvider.ProviderEffect),
      ),
    ),
  )

beforeAll(async () => {
  const m = Address.Network.Mainnet
  baseKeyKey = Address.toBech32Sync(Address.baseHex(m, PAY, STAKE))
  baseKeyKey2 = Address.toBech32Sync(Address.baseHex(m, PAY2, STAKE))
  baseScriptKey = Address.toBech32Sync(Address.baseScriptHex(m, SCRIPT, STAKE))
  enterprise = Address.toBech32Sync(Address.enterpriseHex(m, PAY))
  reward = Address.toBech32Sync(Address.rewardHex(m, STAKE))
  testnetBase = Address.toBech32Sync(Address.baseHex(Address.Network.Testnet, PAY, STAKE))
})

describe('filterKeyCredentialAddresses', () => {
  it('keeps only key-credential base addresses', () => {
    const kept = filterKeyCredentialAddresses([baseKeyKey, baseScriptKey, enterprise, reward, baseKeyKey2])
    expect([...kept].sort()).toEqual([baseKeyKey, baseKeyKey2].sort())
  })

  it('drops undecodable entries without throwing', () => {
    expect(filterKeyCredentialAddresses(['not-an-address', baseKeyKey])).toEqual([baseKeyKey])
  })
})

describe('keepOwnedAccountUtxos (ownership gate for account-level fetches)', () => {
  const u = (address: string) => ({txHash: 'aa', index: 0, coin: 1n, assets: [], address})
  const addressOf = (x: {readonly address: string}) => x.address

  it('keeps everything when ownSet is null (watch-only, no gate)', () => {
    const all = [u('a'), u('b'), u('c')]
    expect(keepOwnedAccountUtxos(all, null, addressOf)).toHaveLength(3)
  })

  // ⚠️ "address-less rows" is no longer part of the claim: an address is required on Evolution's
  // `UTxO`, so there is no such row to drop.
  it('keeps only owned addresses, dropping foreign ones', () => {
    const kept = keepOwnedAccountUtxos([u('own1'), u('foreign'), u('own2')], new Set(['own1', 'own2']), addressOf)
    expect(kept.map((x) => x.address)).toEqual(['own1', 'own2'])
  })
})

describe('resolveReadOnlyCardano', () => {
  it('resolves a reward-address input to its key-credential base set', async () => {
    const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, reward), [
      baseKeyKey,
      baseScriptKey, // dropped
      baseKeyKey2,
    ])
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.rewardAddressBech32).toBe(reward)
      expect(exit.value.addresses).toEqual([baseKeyKey, baseKeyKey2].sort())
    }
  })

  it('always includes a base-address input even when the account set is empty', async () => {
    const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, baseKeyKey), [])
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.rewardAddressBech32).toBe(reward)
      expect(exit.value.addresses).toEqual([baseKeyKey])
    }
  })

  it('rejects a wrong-network address', async () => {
    const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, testnetBase))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = exit.cause._tag === 'Fail' ? exit.cause.error : null
      expect(err).toBeInstanceOf(ReadOnlyImportError)
      expect((err as ReadOnlyImportError).reason).toBe('network-mismatch')
    }
  })

  describe('an address with no stake credential', () => {
    // There is no account behind an enterprise address: no reward account to read, no
    // set to enumerate, nothing to delegate. It is still watchable, as itself.
    it('resolves to exactly the address it was given', async () => {
      const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, enterprise), [baseKeyKey, baseKeyKey2])
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.addresses).toEqual([enterprise])
        expect(exit.value.rewardAddressBech32).toBeNull()
        expect(exit.value.stakeKeyHashHex).toBeNull()
      }
    })

    it('seeds the wallet checksum from the payment key, since there is no stake key', async () => {
      const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, enterprise))
      expect(Exit.isSuccess(exit)).toBe(true)
      // Never null: the plate and identicon have to be drawn either way.
      if (Exit.isSuccess(exit)) expect(exit.value.checksumSeedHex).toMatch(/^[0-9a-f]{56}$/)
    })

    it('does not enumerate the account, so a provider miss cannot widen it', async () => {
      // Passing a full account set must change nothing: this wallet is one address.
      const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, enterprise), [baseKeyKey])
      if (Exit.isSuccess(exit)) expect(exit.value.addresses).toHaveLength(1)
    })
  })

  it('rejects a script-payment base address input', async () => {
    const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, baseScriptKey))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
      expect((exit.cause.error as ReadOnlyImportError).reason).toBe('script-payment')
    }
  })

  it('rejects a blank input', async () => {
    const exit = await run(resolveReadOnlyCardano(Address.Network.Mainnet, '   '))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
      expect((exit.cause.error as ReadOnlyImportError).reason).toBe('invalid-address')
    }
  })
})
